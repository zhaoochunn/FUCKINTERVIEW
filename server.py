"""FUCKINTERVIEW —— 本地开发入口。

- 复用 Pipecat 官方 dev runner（SmallWebRTC、/start、/api/offer 等）
- 额外提供 /api/settings 读写配置
- 用本项目构建的前端替换官方预置 UI（挂载在 /client）
"""

import asyncio
import json
import os
import uuid
from pathlib import Path

import aiohttp
from fastapi import File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from loguru import logger
from starlette.concurrency import run_in_threadpool
from starlette.staticfiles import StaticFiles

from pipecat.frames.frames import (
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputTransportMessageFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.aggregators.llm_text_processor import LLMTextProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
import pipecat.runner.run as runner_run
from pipecat.runner.run import app, main
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import create_transport
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import (
    TurnAnalyzerUserTurnStopStrategy,
)
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

from app.config import (
    load_settings,
    migrate_legacy_data,
    save_model_dir,
    save_settings,
)
from app import documents as documents_store
from app import qa as qa_store
from app import qa_import, qa_index
from app import security
from app import sessions as sessions_store
from app import storage_migration
from app import terms as terms_store
from app.session_recorder import SessionRecorder
from app.materials import (
    CardChanged,
    apply_coach_result,
    apply_plan,
    card_version,
    create_profile,
    delete_profile,
    find_card,
    get_profile,
    latest_profile,
    list_profiles,
    open_folder,
    pick_folder,
    storage_info,
    update_card,
    update_coach_slots,
    update_profile,
)
from app.materials_ai import (
    COACH_DIMENSION_KEYS,
    build_live_system_prompt,
    coach_merge,
    coach_questions,
    consolidate,
    generate_card,
    plan_units,
)
from pipecat.utils.security.redaction import redact_secrets
from app.ai import LLMError
from app.providers import build_llm, build_stt

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "web" / "client" / "dist"

# 安装版从旧版本升级时，数据可能还在安装目录里；这里一次性搬到
# INTERVIEW_DATA_DIR 指向的位置。开发环境两者相同，是空操作。
migrate_legacy_data()

# 只允许本机回环来源访问，并给 /api/* 加本次启动的随机令牌。
security.install(app)


def _log_build_info() -> None:
    """安装版启动时把构建对应的 commit 写进 backend.log。"""
    path = ROOT / "build-info.json"
    if not path.is_file():
        return
    try:
        info = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    logger.info(
        "Build channel={} version={} commit={} dirty={} builtAt={}".format(
            os.environ.get("INTERVIEW_CHANNEL") or "unknown",
            info.get("version") or "?",
            str(info.get("commit") or "?")[:12],
            info.get("dirty"),
            info.get("builtAt") or "?",
        )
    )


_log_build_info()


# --------------------------------------------------------------------------
# 配置接口
# --------------------------------------------------------------------------
@app.get("/api/settings")
async def get_settings():
    return load_settings()


@app.post("/api/settings")
async def update_settings(request: Request):
    try:
        payload = await request.json()
        return save_settings(payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"保存配置失败: {e}")


# --------------------------------------------------------------------------
# 面试材料：面试档案（简历 / 岗位描述 / 经历卡）与数据目录
# --------------------------------------------------------------------------
def _profile_or_404(profile_id: str):
    try:
        return get_profile(profile_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="档案不存在")


@app.get("/api/profiles")
async def api_list_profiles():
    return {"profiles": list_profiles()}


@app.post("/api/profiles")
async def api_create_profile(request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    name = str(payload.get("name") or "") if isinstance(payload, dict) else ""
    return create_profile(name)


@app.get("/api/profiles/{profile_id}")
async def api_get_profile(profile_id: str):
    return _profile_or_404(profile_id)


@app.patch("/api/profiles/{profile_id}")
async def api_patch_profile(profile_id: str, request: Request):
    payload = await request.json()
    try:
        return update_profile(profile_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="档案不存在")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/profiles/{profile_id}")
async def api_delete_profile(profile_id: str):
    try:
        delete_profile(profile_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="档案不存在")
    return {"ok": True}


@app.post("/api/profiles/{profile_id}/consolidate")
async def api_consolidate(profile_id: str, request: Request):
    profile = _profile_or_404(profile_id)
    payload = await request.json()
    kind = str(payload.get("kind") or "")
    if kind not in ("resume", "jobDescription"):
        raise HTTPException(status_code=400, detail="kind 必须是 resume 或 jobDescription")

    content = str(payload.get("content") or "")
    if not content.strip():
        content = str(profile[kind].get("content") or "")
    if not content.strip():
        raise HTTPException(status_code=400, detail="没有可以整合的内容")

    language = str(payload.get("language") or profile.get("language") or "zh")
    try:
        text = await consolidate(load_settings(), content=content, language=language)
    except LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return {"content": text}


@app.post("/api/profiles/{profile_id}/skills/plan")
async def api_plan_skills(profile_id: str):
    profile = _profile_or_404(profile_id)
    resume = str(profile["resume"].get("content") or "")
    description = str(profile["jobDescription"].get("content") or "")
    if not resume.strip():
        raise HTTPException(status_code=400, detail="简历为空，无法生成经历卡")
    if not description.strip():
        raise HTTPException(status_code=400, detail="岗位描述为空，无法生成经历卡")

    try:
        units = await plan_units(
            load_settings(),
            resume=resume,
            job_description=description,
            language=str(profile.get("language") or "zh"),
        )
    except LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return apply_plan(profile_id, units)


@app.post("/api/profiles/{profile_id}/skills/{slug}/generate")
async def api_generate_skill(profile_id: str, slug: str):
    profile = _profile_or_404(profile_id)
    try:
        card = find_card(profile_id, slug)
    except KeyError:
        raise HTTPException(status_code=404, detail="经历卡不存在")

    try:
        fields = await generate_card(
            load_settings(),
            unit=card,
            resume=str(profile["resume"].get("content") or ""),
            job_description=str(profile["jobDescription"].get("content") or ""),
            language=str(profile.get("language") or "zh"),
        )
    except LLMError as e:
        update_card(profile_id, slug, {"status": "failed", "error": str(e)})
        raise HTTPException(status_code=502, detail=str(e))

    try:
        return update_card(profile_id, slug, fields)
    except KeyError:
        raise HTTPException(status_code=404, detail="经历卡不存在")


# --------------------------------------------------------------------------
# 完善经历卡：按固定维度出题、逐格保存回答、再一次性写回卡片
#
# 教练不用对话历史：状态就是档案里的 coachSlots（问题 + 回答），
# 所以中断后重新打开只是「接着看清单」，不依赖模型理解聊天记录。
# --------------------------------------------------------------------------
def _slots_of(profile: dict, slug: str) -> dict:
    return dict((profile.get("coachSlots") or {}).get(slug) or {})


def _ordered_slots(slots: dict) -> dict:
    return {key: slots[key] for key in COACH_DIMENSION_KEYS if key in slots}


def _slots_response(profile: dict, slug: str) -> dict:
    """返回这张卡的清单 + 整张表：前端用整表覆盖，避免拿着旧快照互相覆盖。"""
    all_slots = profile.get("coachSlots") or {}
    return {
        "slots": _ordered_slots(all_slots.get(slug) or {}),
        "coachSlots": all_slots,
    }


@app.post("/api/profiles/{profile_id}/coach/questions")
async def api_coach_questions(profile_id: str, request: Request):
    """取这张卡的补全清单；第一次打开时让 AI 一次性出 6 个问题并落盘。"""
    profile = _profile_or_404(profile_id)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    slug = str(payload.get("slug") or "").strip()
    try:
        card = find_card(profile_id, slug)
    except KeyError:
        raise HTTPException(status_code=404, detail="经历卡不存在")

    slots = _slots_of(profile, slug)
    missing = [key for key in COACH_DIMENSION_KEYS if not (slots.get(key) or {}).get("q")]
    if missing:
        try:
            generated = await coach_questions(load_settings(), profile, card)
        except LLMError as e:
            raise HTTPException(status_code=502, detail=str(e))
        for key in missing:
            text = generated.get(key)
            if text:
                slots[key] = {**(slots.get(key) or {}), "q": text}
        profile = update_coach_slots(profile_id, slug, slots)

    return _slots_response(profile, slug)


@app.post("/api/profiles/{profile_id}/coach/answer")
async def api_coach_answer(profile_id: str, request: Request):
    """保存一格回答。纯本地写盘，不调模型，失败了也不会丢已经答的内容。"""
    profile = _profile_or_404(profile_id)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    slug = str(payload.get("slug") or "").strip()
    dimension = str(payload.get("dimension") or "").strip()
    answer = str(payload.get("answer") or "").strip()
    if dimension not in COACH_DIMENSION_KEYS:
        raise HTTPException(status_code=400, detail="未知的维度")
    if not answer:
        raise HTTPException(status_code=400, detail="回答不能为空")
    try:
        find_card(profile_id, slug)
    except KeyError:
        raise HTTPException(status_code=404, detail="经历卡不存在")

    slots = _slots_of(profile, slug)
    slot = slots.get(dimension) or {}
    slots[dimension] = {**slot, "a": answer[:4000], "applied": False}
    saved = update_coach_slots(profile_id, slug, slots)
    return _slots_response(saved, slug)


@app.post("/api/profiles/{profile_id}/coach/apply")
async def api_coach_apply(profile_id: str, request: Request):
    """把还没写回的回答合并进这张卡，返回整份档案。"""
    profile = _profile_or_404(profile_id)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    slug = str(payload.get("slug") or "").strip()
    try:
        card = find_card(profile_id, slug)
    except KeyError:
        raise HTTPException(status_code=404, detail="经历卡不存在")

    slots = _slots_of(profile, slug)
    pending = [
        {
            "dimension": key,
            "question": str((slots.get(key) or {}).get("q") or ""),
            "answer": str((slots.get(key) or {}).get("a") or ""),
        }
        for key in COACH_DIMENSION_KEYS
        if (slots.get(key) or {}).get("a") and not (slots.get(key) or {}).get("applied")
    ]
    if not pending:
        raise HTTPException(status_code=400, detail="没有新的回答可以写入")

    # 模型调用可能持续好几秒；期间用户可能继续编辑同一格回答或卡片正文。
    # 记下发车时的回答和卡片指纹，写回时只提交仍然有效的那部分。
    expected_answers = {item["dimension"]: item["answer"] for item in pending}
    expected_card = card_version(card)

    try:
        fields = await coach_merge(load_settings(), profile, card, pending)
    except LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))

    try:
        return apply_coach_result(
            profile_id,
            slug,
            fields,
            [item["dimension"] for item in pending],
            expected_answers=expected_answers,
            expected_card_version=expected_card,
        )
    except CardChanged as e:
        raise HTTPException(status_code=409, detail=str(e))
    except KeyError:
        raise HTTPException(status_code=404, detail="经历卡不存在")


# --------------------------------------------------------------------------
# 其他资料：面试时展示用的 md / pdf
#
# 只做展示，不进 prompt、不进检索——上传的内容不会影响模型回答。
# --------------------------------------------------------------------------
@app.get("/api/documents")
async def api_list_documents():
    return {"documents": documents_store.list_documents()}


@app.post("/api/documents")
async def api_upload_document(file: UploadFile = File(...)):
    data = await file.read()
    try:
        return documents_store.add_document(file.filename or "", data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        await file.close()


@app.patch("/api/documents/{document_id}")
async def api_rename_document(document_id: str, request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    title = str(payload.get("title") or "") if isinstance(payload, dict) else ""
    try:
        return documents_store.rename_document(document_id, title)
    except KeyError:
        raise HTTPException(status_code=404, detail="资料不存在")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/documents/{document_id}")
async def api_delete_document(document_id: str):
    try:
        documents_store.delete_document(document_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="资料不存在")
    return {"ok": True}


@app.get("/api/documents/{document_id}/file")
async def api_document_file(document_id: str):
    """原件直出；FileResponse 自带 Range 支持，PDF 按需分片读取。"""
    try:
        path, entry = documents_store.document_file(document_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="资料不存在")
    media_type = (
        "application/pdf" if entry["ext"] == "pdf" else "text/markdown; charset=utf-8"
    )
    return FileResponse(path, media_type=media_type)


def _storage_payload() -> dict:
    settings = load_settings()
    raw_model = str((settings.get("storage") or {}).get("model_dir") or "").strip()
    return {
        **storage_info(),
        "modelDir": str(qa_index.model_dir()),
        # 空表示「跟随数据目录」，界面上用空输入 + placeholder 表达。
        "modelDirCustom": bool(raw_model),
    }


@app.get("/api/storage")
async def api_storage():
    return _storage_payload()


@app.put("/api/storage")
async def api_set_storage(request: Request):
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")

    data_dir_value = str(payload.get("dataDir") or "").strip()
    model_dir = payload.get("modelDir")
    model_dir_supplied = "modelDir" in payload
    model_dir_value = model_dir.strip() if isinstance(model_dir, str) else ""

    if data_dir_value:
        try:
            await run_in_threadpool(
                storage_migration.migrate_data_dir,
                data_dir_value,
                migrate=bool(payload.get("migrate", True)),
            )
        except storage_migration.StorageConflict as e:
            raise HTTPException(status_code=409, detail=str(e))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except OSError as e:
            raise HTTPException(status_code=400, detail=f"迁移数据目录失败：{e}")

    if model_dir_supplied:
        # 空字符串 = 恢复「跟随数据目录」，不是「不改」。
        save_model_dir(model_dir_value)
        qa_index.invalidate()
        qa_index.reset_model_failure()

    return _storage_payload()


@app.post("/api/storage/pick")
async def api_pick_folder(request: Request):
    """弹系统文件夹选择器，返回选中的路径（取消时为空串）。"""
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    initial = ""
    if isinstance(payload, dict):
        initial = str(payload.get("path") or "").strip()
    try:
        path = await run_in_threadpool(pick_folder, initial)
    except OSError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"path": path}


@app.post("/api/storage/open")
async def api_open_storage():
    try:
        open_folder()
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"打开目录失败：{e}")
    return {"ok": True}


# --------------------------------------------------------------------------
# 面试历史：首页看板与历史记录页
#
# 静态路径必须声明在 /api/sessions/{session_id} 之前，否则会被当成 id 解析。
# --------------------------------------------------------------------------
def _current_models() -> dict[str, dict[str, str]]:
    settings = load_settings()
    return {
        section: {
            "provider": str((settings.get(section) or {}).get("provider") or ""),
            "model": str((settings.get(section) or {}).get("model") or ""),
        }
        for section in ("asr", "llm", "tts")
    }


@app.get("/api/sessions/stats")
async def api_session_stats():
    return {**sessions_store.stats(), "models": _current_models()}


@app.post("/api/sessions/end")
async def api_session_end(request: Request):
    """前端主动结束（点断开、切页）时上报，用来区分正常结束和意外中断。"""
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    interview_id = str(payload.get("interviewId") or "").strip()
    if not interview_id:
        raise HTTPException(status_code=400, detail="缺少 interviewId")
    sessions_store.mark_completed(interview_id)
    return {"ok": True}


@app.get("/api/sessions")
async def api_session_list(
    mode: str = Query("all"),
    limit: int = Query(30, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    normalized = mode if mode in sessions_store.MODES else None
    return sessions_store.list_sessions(mode=normalized, limit=limit, offset=offset)


@app.get("/api/sessions/{session_id}")
async def api_session_detail(session_id: int):
    session = sessions_store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    return session


# --------------------------------------------------------------------------
# 问答库
#
# 写入只落库，向量由后台线程异步补算，所以界面不会被索引卡住。
# 静态路径必须声明在 /api/qa/{qa_id} 之前，否则会被当成 id 解析。
# --------------------------------------------------------------------------
@app.get("/api/qa/stats")
async def api_qa_stats():
    return qa_index.status()


@app.post("/api/qa/reindex")
async def api_qa_reindex(request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    scope = str((payload or {}).get("scope") or "stale")
    if scope not in ("all", "failed", "stale"):
        raise HTTPException(status_code=400, detail="scope 必须是 all / failed / stale")
    # 用户主动重建索引，允许再试一次模型下载。
    qa_index.reset_model_failure()
    return {"queued": qa_index.reindex(scope)}


@app.post("/api/qa/search")
async def api_qa_search(request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    try:
        # ONNX 推理 / 模型加载都是同步阻塞的，必须放线程池，否则会卡住
        # /status、/start 和正在进行的实时面试。
        return await run_in_threadpool(
            qa_index.search,
            str(payload.get("q") or ""),
            int(payload.get("limit") or 20),
            [str(v) for v in payload.get("types") or []],
            str(payload.get("profileId") or "") or None,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/api/qa")
async def api_qa_list(
    q: str = "",
    type_: str = Query("", alias="type"),
    status: str = "",
    profileId: str = "",
    limit: int = 50,
    offset: int = 0,
):
    return qa_store.list_qa(
        q=q,
        type_=type_,
        status=status,
        profile_id=profileId or None,
        limit=limit,
        offset=offset,
    )


@app.post("/api/qa")
async def api_qa_create(request: Request):
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    try:
        item = qa_store.create_qa(payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    qa_index.enqueue(item["id"])
    return item


@app.get("/api/qa/{qa_id}")
async def api_qa_get(qa_id: int):
    item = qa_store.get_qa(qa_id)
    if item is None:
        raise HTTPException(status_code=404, detail="问答不存在")
    return item


@app.patch("/api/qa/{qa_id}")
async def api_qa_patch(qa_id: int, request: Request):
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    try:
        item = qa_store.update_qa(qa_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="问答不存在")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    qa_index.enqueue(qa_id)
    return item


@app.delete("/api/qa/{qa_id}")
async def api_qa_delete(qa_id: int):
    qa_store.delete_qa(qa_id)
    qa_index.invalidate()
    return {"ok": True}


@app.post("/api/qa/bulk-delete")
async def api_qa_bulk_delete(request: Request):
    payload = await request.json()
    ids = payload.get("ids") if isinstance(payload, dict) else None
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="ids 必须是数组")
    deleted = qa_store.bulk_delete([int(i) for i in ids])
    qa_index.invalidate()
    return {"deleted": deleted}


@app.post("/api/qa/import/preview")
async def api_qa_import_preview(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        # 预览里会做向量相似度计算，放线程池，别卡住事件循环。
        return await run_in_threadpool(qa_import.preview, raw, file.filename or "")
    except qa_import.ImportError_ as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.post("/api/qa/import/commit")
async def api_qa_import_commit(request: Request):
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    try:
        return await run_in_threadpool(
            qa_import.commit,
            str(payload.get("token") or ""),
            str(payload.get("mode") or "merge"),
        )
    except qa_import.ImportError_ as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/qa/imports/{import_id}")
async def api_qa_undo_import(import_id: int):
    return {"deleted": qa_store.undo_import(import_id)}


# --------------------------------------------------------------------------
# 术语库
#
# 静态路径必须声明在 /api/terms/{term_id} 之前，否则会被当成 id 解析。
# --------------------------------------------------------------------------
@app.get("/api/terms/stats")
async def api_terms_stats():
    return terms_store.stats()


@app.get("/api/terms/templates")
async def api_terms_templates():
    return {"items": terms_store.list_templates()}


@app.post("/api/terms/templates")
async def api_terms_template_create(request: Request):
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    try:
        return terms_store.create_template(str(payload.get("name") or ""))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.patch("/api/terms/templates/{name}")
async def api_terms_template_rename(name: str, request: Request):
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    try:
        terms_store.rename_template(name, str(payload.get("name") or ""))
    except KeyError:
        raise HTTPException(status_code=404, detail="模板不存在")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@app.delete("/api/terms/templates/{name}")
async def api_terms_template_delete(name: str):
    try:
        terms_store.delete_template(name)
    except KeyError:
        raise HTTPException(status_code=404, detail="模板不存在")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True}


@app.post("/api/terms/templates/{name}")
async def api_terms_template_toggle(name: str, request: Request):
    payload = await request.json()
    enabled = bool((payload or {}).get("enabled")) if isinstance(payload, dict) else False
    try:
        return terms_store.set_template_enabled(name, enabled)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/terms/templates/{name}/reset")
async def api_terms_template_reset(name: str):
    try:
        return {"restored": terms_store.reset_template(name)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/terms/parse")
async def api_terms_parse(request: Request):
    payload = await request.json()
    text = str((payload or {}).get("text") or "") if isinstance(payload, dict) else ""
    return terms_store.parse_bulk(text)


@app.post("/api/terms/bulk")
async def api_terms_bulk(request: Request):
    payload = await request.json()
    text = str((payload or {}).get("text") or "") if isinstance(payload, dict) else ""
    return terms_store.bulk_create(text)


@app.get("/api/terms/recent")
async def api_terms_recent():
    """最近一场实时面试里纠正过的词，以及疑似被听错的词。"""
    return sessions_store.recent_corrections()


@app.post("/api/terms/recent/clear")
async def api_terms_recent_clear():
    sessions_store.clear_recent_corrections()
    return {"ok": True}


@app.get("/api/terms")
async def api_terms_list(q: str = "", template: str = ""):
    return terms_store.list_terms(q=q, template=template)


@app.post("/api/terms")
async def api_terms_create(request: Request):
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    try:
        return terms_store.create_term(payload)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.patch("/api/terms/{term_id}")
async def api_terms_patch(term_id: int, request: Request):
    payload = await request.json()
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="请求体必须是 JSON 对象")
    try:
        return terms_store.update_term(term_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="术语不存在")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.delete("/api/terms/{term_id}")
async def api_terms_delete(term_id: int):
    if not terms_store.delete_term(term_id):
        raise HTTPException(status_code=404, detail="术语不存在")
    return {"ok": True}


# --------------------------------------------------------------------------
# 前端：用本项目构建的界面替换官方预置 UI
#
# Runner 在 main() 里调用 _setup_frontend_routes(app) 挂载官方 UI，
# 这里替换该函数，让同一路径 /client 指向本项目的构建产物。
# --------------------------------------------------------------------------
_original_setup_frontend = runner_run._setup_frontend_routes


def _setup_project_frontend(fastapi_app):
    if not DIST.is_dir():
        logger.warning(f"未找到前端构建产物 {DIST}，继续使用官方预置 UI")
        _original_setup_frontend(fastapi_app)
        return

    index_html = DIST / "index.html"

    @fastapi_app.get("/client/", include_in_schema=False)
    @fastapi_app.get("/client/index.html", include_in_schema=False)
    async def client_index():
        # 只把本次启动的访问令牌交给本应用页面；跨源页面拿不到这份 HTML。
        # 令牌每次启动都会变，HTML 不能让浏览器缓存。
        html = index_html.read_text(encoding="utf-8")
        return HTMLResponse(
            security.inject_token(html),
            headers={"Cache-Control": "no-store"},
        )

    fastapi_app.mount(
        "/client", StaticFiles(directory=str(DIST), html=True), name="interview-ui"
    )

    @fastapi_app.get("/", include_in_schema=False)
    async def root_redirect():
        return RedirectResponse(url="/client/")


runner_run._setup_frontend_routes = _setup_project_frontend


# --------------------------------------------------------------------------
# 语音 pipeline
# --------------------------------------------------------------------------
transport_params = {
    "webrtc": lambda: TransportParams(
        audio_in_enabled=True,
        audio_out_enabled=True,
    ),
}


# 回合结束的兜底等待。smart-turn 模型通常 0.2–0.4 秒就判完「说完了」，
# pipecat 默认的 3 秒只是模型犹豫时的兜底——日志里真出现过一次，等于凭空
# 多等 1.5 秒。1.2 秒对正常提问足够长，也不会把句中的停顿当成说完了。
TURN_STOP_SECS = 1.2

# VAD 的音量门槛（ITU-R BS.1770 归一化到 0–1）。默认 0.6 对很轻的系统
# 音频偏高，调到 0.45（约 -60 LUFS）仍然远低于正常说话。
VAD_MIN_VOLUME = 0.45

# 两路实时面试会同时建两条 pipeline，每场都重新加载 2.2MB / 8.3MB 的 ONNX
# 模型；模型文件本身是无状态的，把底层 InferenceSession 复用，分析器仍然
# 每场新建（VAD / 断句的流内状态不能跨会话共享）。
_vad_session = None
_smart_turn_session = None


def _shared_vad_analyzer():
    global _vad_session
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams

    # pipecat 默认 min_volume=0.6（约 -50 LUFS）。系统音频被调得很小时，
    # 轻声帧会被音量门槛挡掉（10% 系统音量实测只有 61% 的语音帧通过，
    # 正常音量是 76%），切句和识别都会受影响。调到 0.45 兜底；客户端
    # 另外做了自动增益。
    analyzer = SileroVADAnalyzer(params=VADParams(min_volume=VAD_MIN_VOLUME))
    if _vad_session is None:
        _vad_session = analyzer._model.session
    else:
        analyzer._model.session = _vad_session
    return analyzer


def _shared_smart_turn_analyzer():
    global _smart_turn_session
    from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
    from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3

    analyzer = LocalSmartTurnAnalyzerV3(
        params=SmartTurnParams(stop_secs=TURN_STOP_SECS)
    )
    if _smart_turn_session is None:
        _smart_turn_session = analyzer._session
    else:
        analyzer._session = _smart_turn_session
    return analyzer


def _user_turn_params() -> LLMUserAggregatorParams:
    return LLMUserAggregatorParams(
        vad_analyzer=_shared_vad_analyzer(),
        user_turn_strategies=UserTurnStrategies(
            stop=[TurnAnalyzerUserTurnStopStrategy(turn_analyzer=_shared_smart_turn_analyzer())]
        ),
    )


class TextOnlyOutput(FrameProcessor):
    """把 LLM 的输出标记为「不朗读」。

    实时面试没有 TTS，所以每个输出帧都必须带 skip_tts=True；否则
    RTVIObserver 会等一个永远不会出现的 BotStartedSpeakingFrame，
    聚合文本也就发不到前端。放在 LLM 之后、LLMTextProcessor 之前。
    """

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(
            frame,
            (LLMTextFrame, LLMFullResponseStartFrame, LLMFullResponseEndFrame),
        ):
            frame.skip_tts = True
        await self.push_frame(frame, direction)


class TermCorrector(FrameProcessor):
    """把转写里被 ASR 听错的术语改回规范写法。

    放在 STT 和用户聚合器之间：聚合器、问答库检索和模型拿到的都是改好的文本，
    而且改写在发出之前完成，前端看到的转写也是规范写法。原文不再保留——
    改了什么通过下面那条 server message 告诉界面。
    """

    def __init__(self):
        super().__init__()
        # 本场说过的所有话：术语释义按（改写后的）它来筛选，
        # 离线找疑似别名时用原始转写——改写过就找不到近似词了。
        self.transcript: list[str] = []
        self.raw: list[str] = []
        self.hits: list[dict[str, str]] = []

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and direction == FrameDirection.DOWNSTREAM:
            text, hits = terms_store.correct(frame.text)
            self.raw.append(frame.text)
            self.hits += hits
            if hits:
                frame.text = text
            self.transcript.append(text)
            if hits:
                await self.push_frame(
                    OutputTransportMessageFrame(
                        message={
                            "type": "server-message",
                            "data": {"kind": "glossary.corrected", "corrections": hits},
                        }
                    )
                )
        await self.push_frame(frame, direction)


# 每回合保留的对话消息条数：一问一答算两条。
HISTORY_MESSAGES = 20


def _apply_system_prompt(llm, prompt: str) -> None:
    """把新的系统提示词装回已经建好的 LLM 服务。

    Pipecat 没有运行期改提示词的公开接口；``_compose_system_instruction()``
    会把基座提示词和回合补全、异步工具这些附加指令重新拼一遍，所以不能只写
    ``_settings.system_instruction``，否则附加指令会被冲掉。
    """
    compose = getattr(llm, "_compose_system_instruction", None)
    if compose is None or not hasattr(llm, "_base_system_instruction"):
        llm._settings.system_instruction = prompt
        return
    llm._base_system_instruction = prompt
    compose()


class GlossaryPrompt(FrameProcessor):
    """每回合刷新系统提示词里的术语段，并把对话历史裁到最近若干条。

    术语段只放「本场提到过、而且带释义」的词条，所以通常只有几百字符；
    内容没变就不碰系统提示词，免得白白让供应商的前缀缓存失效。
    """

    def __init__(self, llm, build_prompt, transcript: list[str]):
        super().__init__()
        self._llm = llm
        self._build_prompt = build_prompt
        self._transcript = transcript
        self._glossary: str | None = None

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame) and direction == FrameDirection.DOWNSTREAM:
            self._trim(frame.context)
            glossary = terms_store.render_glossary("\n".join(self._transcript))
            if glossary != self._glossary:
                self._glossary = glossary
                _apply_system_prompt(self._llm, self._build_prompt(glossary))
        await self.push_frame(frame, direction)

    def _trim(self, context: LLMContext) -> None:
        messages = getattr(context, "messages", None)
        if not isinstance(messages, list) or len(messages) <= HISTORY_MESSAGES:
            return
        kept = messages[-HISTORY_MESSAGES:]
        if hasattr(context, "set_messages"):
            context.set_messages(kept)
        else:
            messages[:] = kept


def _live_profile(body: dict) -> dict | None:
    """实时面试要用的档案：优先用前端传来的 profileId，否则取最近编辑的一份。"""
    profile_id = str(body.get("profileId") or "").strip()
    if profile_id:
        try:
            return get_profile(profile_id)
        except KeyError:
            logger.warning(f"实时面试找不到档案 {profile_id}，改用最近编辑的一份")
    return latest_profile()


# 命中问答库后可以直接贴原文的类型。项目技术类必须走 LLM + 档案：
# 库里的标准答案会盖掉你项目卡里更具体的细节。
DIRECT_QA_TYPES = ("general", "behavioral", "knowledge")


def _last_user_text(context: LLMContext) -> str:
    """上下文里最后一条用户消息——也就是面试官刚问的那句。"""
    for message in reversed(getattr(context, "messages", None) or []):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            return " ".join(
                part.get("text") or "" for part in content if isinstance(part, dict)
            ).strip()
    return ""


class QaAnswer(FrameProcessor):
    """实时面试：面试官的问题先过一遍问答库。

    放在用户聚合器和 LLM 之间，拦住那个触发推理的 LLMContextFrame：
    命中（相似度 >= 阈值，且类型不在「项目技术」）就把库里的答案原样推出去，
    这一轮**不跑 LLM**；没命中才放行，让 LLM 用面试档案回答。

    模型没下载、检索报错一律当作没命中——面试不能因为问答库挂掉而中断。
    """

    def __init__(self, settings: dict):
        super().__init__()
        embedding = settings.get("embedding") or {}
        try:
            self._threshold = float(embedding.get("relevance_threshold") or 0.75)
        except (TypeError, ValueError):
            self._threshold = 0.75

    async def process_frame(self, frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame) and direction == FrameDirection.DOWNSTREAM:
            answer = await self._lookup(_last_user_text(frame.context))
            if answer:
                await self.push_frame(LLMFullResponseStartFrame())
                await self.push_frame(LLMTextFrame(text=answer))
                await self.push_frame(LLMFullResponseEndFrame())
                return
        await self.push_frame(frame, direction)

    async def _lookup(self, text: str) -> str | None:
        if not text:
            return None
        try:
            result = await run_in_threadpool(
                qa_index.search, text, 3, list(DIRECT_QA_TYPES), None
            )
        except Exception as error:
            logger.warning(f"问答库检索失败，这一轮交给 LLM：{error}")
            return None

        # 结果是按 RRF 排的，不是按余弦分数；纯关键词命中的 score 还是 0。
        # 不能遇到第一个低分就 break——后面可能还有高相似度的向量命中。
        best: tuple[float, str, str] | None = None
        for item in result.get("results") or []:
            try:
                score = float(item.get("score") or 0)
            except (TypeError, ValueError):
                continue
            if score < self._threshold:
                continue
            answer = str(item.get("answer") or "").strip()
            if not answer:
                continue
            if best is None or score > best[0]:
                best = (score, answer, str(item.get("question") or ""))
        if best is not None:
            score, answer, question = best
            logger.info(f"问答库命中「{question}」score={score:.2f}，直接贴原文")
            return answer
        return None


async def _warm_qa_model() -> None:
    """提前把向量模型加载进来，别让开场第一个问题多等一次冷启动。"""
    try:
        await run_in_threadpool(qa_index.get_model)
    except Exception as error:
        logger.warning(f"问答库向量模型预热失败，实时面试将全部交给 LLM：{error}")


def _model_snapshot(settings: dict, mode: str) -> dict[str, str | None]:
    """这场实际用到的模型，随会话留档；历史里换过模型也看得出当时用的哪套。"""

    def label(section: str) -> str | None:
        raw = settings.get(section) or {}
        provider = str(raw.get("provider") or "").strip()
        model = str(raw.get("model") or "").strip()
        if provider and model:
            return f"{provider}/{model}"
        return model or provider or None

    return {
        "asr": label("asr"),
        "llm": None if mode == "listen" else label("llm"),
        # 模拟面试已从产品移除，后端不再合成语音；历史里仍保留这个字段。
        "tts": None,
    }


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments):
    settings = load_settings()
    body = runner_args.body if isinstance(runner_args.body, dict) else {}
    mode = str(body.get("mode", "live")).lower()
    if mode not in ("live", "listen"):
        mode = "live"

    # 一场实时面试两条连接（面试官 + 候选人）靠 interviewId 拼成同一场；
    # 老客户端没带 id 时各连各的，至少不会丢记录。
    interview_id = str(body.get("interviewId") or "").strip() or uuid.uuid4().hex
    session_mode = "live"
    try:
        session_id: int | None = sessions_store.open_session(
            interview_id, session_mode, models=_model_snapshot(settings, mode)
        )
    except Exception as error:
        # 记录失败不能拖垮面试本身；这场照样进行，只是不进历史。
        logger.warning(f"开启面试记录失败，这场不写历史：{error}")
        session_id = None
    recorder = SessionRecorder(
        session_id=session_id,
        role="candidate" if mode == "listen" else "interviewer",
        record_assistant=mode != "listen",
        qa_source="QaAnswer" if mode == "live" else None,
    )

    logger.info(
        f"Starting bot mode={mode} session={interview_id} with "
        f"ASR={settings['asr'].get('provider')}/{settings['asr'].get('model')}, "
        f"LLM={settings['llm'].get('provider')}/{settings['llm'].get('model')}, "
        f"TTS={settings['tts'].get('provider')}/{settings['tts'].get('model')}"
    )

    warm_tasks: list[asyncio.Task] = []
    finished = False
    corrector = None

    def finish_session():
        nonlocal finished
        if finished:
            return
        finished = True
        if session_id is not None:
            try:
                if mode == "listen":
                    # 候选人那路只贡献转写和 STT 用量，收尾归面试官那路。
                    sessions_store.add_metrics(session_id, **recorder.finish())
                else:
                    metrics = recorder.finish()
                    if mode == "live" and corrector is not None and corrector.raw:
                        sessions_store.add_corrections(
                            session_id,
                            corrector.hits,
                            terms_store.referenced_confusions(
                                "\n".join(corrector.raw)
                            ),
                        )
                    sessions_store.finalize_session(session_id, metrics=metrics)
            except Exception as error:
                # 历史写失败不能影响断开本身。
                logger.warning(f"写入面试历史失败：{error}")

    try:
        async with aiohttp.ClientSession() as session:
            try:
                # 复用同一个 aiohttp 会话：ASR 和 TTS 共用连接池，也方便提前
                # 建好到 ASR 服务的 TLS 连接。
                stt = build_stt(settings["asr"], session=session)
            except Exception as error:
                logger.error(
                    f"ASR 初始化失败（{settings['asr'].get('provider')}/"
                    f"{settings['asr'].get('model')}）：{redact_secrets(str(error))}"
                )
                raise

            # 预热 ASR 连接（不阻塞建 pipeline）：把 DNS/TLS 握手放在用户
            # 开口之前，第一段语音不用再额外等连接建立。
            warm_up = getattr(stt, "warm_up", None)
            if callable(warm_up):
                warm_tasks.append(asyncio.create_task(warm_up()))

            # live 模式用不到 TTS：答案只以文本形式推给前端。
            # listen 是实时面试的第二路（麦克风），只做转写。
            # live 用「候选人视角」的提示词，并把绑定档案的事实塞进去。
            if mode == "listen":
                llm = None
                prompt_builder = None
            else:
                profile = _live_profile(body)
                if profile and session_id is not None:
                    sessions_store.set_profile(
                        session_id, profile.get("id"), profile.get("name")
                    )
                llm_settings = dict(settings["llm"])
                llm_settings["system_prompt"] = build_live_system_prompt(profile)
                logger.info(
                    f"Live interview profile={(profile or {}).get('name') or '(none)'}"
                )
                try:
                    llm = build_llm(llm_settings)
                except Exception as error:
                    # 安装版最常见的原因是配置没写到可写目录 / 新装还没填 LLM。
                    # 明确记下来，接线日志时不用再猜。
                    logger.error(
                        f"实时面试 LLM 初始化失败（{settings['llm'].get('provider')}/"
                        f"{settings['llm'].get('model')}）：{redact_secrets(str(error))}"
                    )
                    raise
                prompt_builder = lambda glossary: build_live_system_prompt(profile, glossary)
                # 问答库检索要用向量模型，提前在后台加载。
                warm_tasks.append(asyncio.create_task(_warm_qa_model()))

            context = LLMContext()
            corrector = TermCorrector()
            processors = [transport.input(), stt, corrector]

            if mode != "listen":
                user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
                    context,
                    user_params=_user_turn_params(),
                )
                processors.append(user_aggregator)
                # 面试官的问题先查问答库：命中就直接贴原文，这一轮不跑 LLM。
                processors.append(QaAnswer(settings))
                if prompt_builder is not None:
                    processors.append(
                        GlossaryPrompt(llm, prompt_builder, corrector.transcript)
                    )
                processors.append(llm)
                # 实时面试只把文本转成 AggregatedTextFrame，由 RTVIObserver
                # 作为 BotOutput 发给前端，不合成语音。
                processors.append(TextOnlyOutput())
                processors.append(LLMTextProcessor())
                processors += [transport.output(), assistant_aggregator]
            else:
                # 分段 STT 靠 VAD 帧切句，而 VAD 由用户聚合器运行；只听不答的
                # 第二路也必须带上它，否则一段转写都不会产生。
                user_aggregator, _assistant_aggregator = LLMContextAggregatorPair(
                    context,
                    user_params=_user_turn_params(),
                )
                processors += [user_aggregator, transport.output()]

            pipeline = Pipeline(processors)

            worker = PipelineWorker(
                pipeline,
                params=PipelineParams(
                    enable_metrics=True,
                    enable_usage_metrics=True,
                ),
                idle_timeout_secs=runner_args.pipeline_idle_timeout_secs,
                processor_unusable_policy=ProcessorUnusablePolicy.END,
                observers=[recorder],
            )

            runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
            await runner.add_workers(worker)

            @transport.event_handler("on_client_connected")
            async def on_client_connected(transport, client):
                logger.info("Client connected")

            @transport.event_handler("on_client_disconnected")
            async def on_client_disconnected(transport, client):
                logger.info("Client disconnected")
                # Finalize in finally, after pipeline cancellation has drained its observers.
                await runner.cancel()

            await runner.run()
    finally:
        # Also cover provider setup, fatal pipeline failure and task cancellation.
        for task in warm_tasks:
            if not task.done():
                task.cancel()
        if warm_tasks:
            await asyncio.gather(*warm_tasks, return_exceptions=True)
        finish_session()


async def bot(runner_args: RunnerArguments):
    """Runner 每个会话调用一次。"""
    try:
        transport = await create_transport(runner_args, transport_params)
        await run_bot(transport, runner_args)
    except ValueError as e:
        logger.error(f"配置错误: {redact_secrets(str(e))}")
        raise


if __name__ == "__main__":
    # runner 默认给 CORS 配 *；在解析参数前换成当前端口的两条精确 Origin。
    security.prepare_runner_argv()
    main()
