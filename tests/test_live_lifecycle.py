"""Session ownership on failures: real SQLite/recorder, controlled runner/services, no provider calls."""
import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregatorParams
from pipecat.runner.types import RunnerArguments
import app.sessions as sessions
import server

@pytest.mark.parametrize('failure', ['asr', 'llm', 'run', 'cancel', 'disconnect-twice'])
def test_bot_always_finishes_once_and_awaits_all_warmups(tmp_path, monkeypatch, failure):
    monkeypatch.setattr(sessions, 'data_dir', lambda: tmp_path); sessions.reset_cache()
    opened = sessions.open_session
    monkeypatch.setattr(sessions, 'open_session', lambda *a, **kw: opened(*a, started_at=datetime.now(timezone.utc)-timedelta(seconds=90), **kw))
    monkeypatch.setattr(server, 'load_settings', lambda: {'asr':{}, 'llm':{}, 'tts':{}})
    monkeypatch.setattr(server, '_live_profile', lambda body: None)
    monkeypatch.setattr(server, '_user_turn_params', lambda: LLMUserAggregatorParams())
    spawned, recorders = [], []
    original_task = asyncio.create_task
    def create_task(coro, **kwargs):
        task = original_task(coro, **kwargs); spawned.append(task); return task
    monkeypatch.setattr(server.asyncio, 'create_task', create_task)
    async def warm(): await asyncio.Event().wait()
    stt = FrameProcessor(); stt.warm_up = warm
    def build_stt(*a, **kw):
        if failure == 'asr': raise ValueError('simulated ASR initialization failure api_key=not-a-real-credential')
        return stt
    def build_llm(*a, **kw):
        if failure == 'llm': raise ValueError('simulated LLM initialization failure Authorization: Bearer not-a-real-credential')
        return FrameProcessor()
    monkeypatch.setattr(server, 'build_stt', build_stt); monkeypatch.setattr(server, 'build_llm', build_llm)
    monkeypatch.setattr(server, '_warm_qa_model', warm)
    recorder_class = server.SessionRecorder
    def recorder(**kwargs):
        instance = recorder_class(**kwargs); instance.finish = Mock(wraps=instance.finish); recorders.append(instance); return instance
    monkeypatch.setattr(server, 'SessionRecorder', recorder)
    transport = SimpleNamespace(handlers={}, input=FrameProcessor, output=FrameProcessor)
    def event_handler(name):
        def decorate(callback): transport.handlers[name] = callback; return callback
        return decorate
    transport.event_handler = event_handler
    monkeypatch.setattr(server, 'PipelineWorker', lambda *a, **kw: object())
    class Runner:
        def __init__(self, **kwargs): pass
        async def add_workers(self, worker): await asyncio.sleep(0)
        async def cancel(self): pass
        async def run(self):
            if failure == 'run': raise RuntimeError('simulated pipeline failure')
            if failure == 'cancel': raise asyncio.CancelledError()
            for _ in range(2): await transport.handlers['on_client_disconnected'](transport, None)
    monkeypatch.setattr(server, 'WorkerRunner', Runner)
    async def exercise():
        call = server.run_bot(transport, RunnerArguments(body={'mode':'live','interviewId':'cleanup-test'}))
        if failure == 'disconnect-twice': await call
        else:
            with pytest.raises(asyncio.CancelledError if failure == 'cancel' else (ValueError, RuntimeError)): await call
        assert recorders[0].finish.call_count == 1
        assert len(spawned) == (0 if failure == 'asr' else 1 if failure == 'llm' else 2)
        assert all(task.done() for task in spawned)
        rows = sessions.list_sessions()['sessions']; assert len(rows) == 1
        assert rows[0]['status'] == 'interrupted'
    logged = []
    sink = server.logger.add(lambda message: logged.append(str(message)), format="{message}")
    try:
        asyncio.run(exercise())
        assert "not-a-real-credential" not in "".join(logged)
    finally:
        server.logger.remove(sink)
        sessions.reset_cache()
