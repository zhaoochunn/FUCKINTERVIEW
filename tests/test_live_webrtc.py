"""Real local RTP/Opus + Pipecat; synthetic audio, ASR and LLM. No credentials/network providers."""
import asyncio
import fractions
import json
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame
from pipecat.frames.frames import (
    InputAudioRawFrame, LLMContextFrame, LLMFullResponseStartFrame,
    LLMTextFrame, LLMFullResponseEndFrame, TranscriptionFrame,
    UserStartedSpeakingFrame, UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.processors.aggregators.llm_response_universal import LLMUserAggregatorParams
from pipecat.runner.types import RunnerArguments
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_start import ExternalUserTurnStartStrategy
from pipecat.turns.user_stop import ExternalUserTurnStopStrategy
import server
import app.sessions as sessions
import app.terms as terms

class Tone(AudioStreamTrack):
    def __init__(self):
        super().__init__(); self.pts = 0; self.started = None
    async def recv(self):
        loop = asyncio.get_running_loop()
        if self.started is None: self.started = loop.time()
        await asyncio.sleep(max(0, self.started + self.pts / 48000 - loop.time()))
        x = np.arange(960) + self.pts
        wave = (np.sin(x * 2 * np.pi * 440 / 48000) * 8000).astype(np.int16)
        frame = AudioFrame(format='s16', layout='stereo', samples=960)
        frame.planes[0].update(np.column_stack((wave, wave)).tobytes())
        frame.sample_rate = 48000; frame.pts = self.pts; frame.time_base = fractions.Fraction(1, 48000)
        self.pts += 960
        return frame

class FakeASR(FrameProcessor):
    def __init__(self, text, warm_tasks):
        super().__init__(); self.text = text; self.received = []; self.done = False; self.warm_tasks = warm_tasks
    async def warm_up(self):
        self.warm_tasks.append(asyncio.current_task())
        await asyncio.Event().wait()
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            self.received.append((frame.sample_rate, frame.num_channels, any(frame.audio)))
            if len(self.received) >= 10 and not self.done:
                self.done = True
                await self.push_frame(UserStartedSpeakingFrame())
                await self.push_frame(TranscriptionFrame(self.text, 'test', '2026-01-01T00:00:00Z'))
                await self.push_frame(UserStoppedSpeakingFrame())
        await self.push_frame(frame, direction)

class FakeLLM(FrameProcessor):
    def __init__(self):
        super().__init__(); self.calls = []; self._settings = type('Settings', (), {'system_instruction': ''})()
    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            self.calls.append(list(frame.context.messages))
            await self.push_frame(LLMFullResponseStartFrame())
            for text in ['模拟答案第一句。', '第二句。']:
                await self.push_frame(LLMTextFrame(text=text))
                await asyncio.sleep(0)
            await self.push_frame(LLMFullResponseEndFrame())
        else:
            await self.push_frame(frame, direction)

@pytest.mark.parametrize('lookup', ['miss', 'hit', 'error'])
def test_dual_lane_rtp_to_transcript_answer_and_history(tmp_path, monkeypatch, lookup):
    monkeypatch.setattr(sessions, 'data_dir', lambda: tmp_path)
    monkeypatch.setattr(terms, 'data_dir', lambda: tmp_path)
    sessions.reset_cache(); terms.reset_cache()
    original_open = sessions.open_session
    monkeypatch.setattr(sessions, 'open_session', lambda *args, **kwargs: original_open(
        *args, started_at=datetime.now(timezone.utc) - timedelta(seconds=90), **kwargs))
    monkeypatch.setattr(server, 'load_settings', lambda: {
        'asr': {'provider': 'test', 'model': 'synthetic'}, 'llm': {'provider': 'test', 'model': 'synthetic'},
        'tts': {}, 'embedding': {'relevance_threshold': 0.75}})
    monkeypatch.setattr(server, '_live_profile', lambda body: None)
    monkeypatch.setattr(server, '_user_turn_params', lambda: LLMUserAggregatorParams(
        user_turn_strategies=UserTurnStrategies(start=[ExternalUserTurnStartStrategy()], stop=[ExternalUserTurnStopStrategy(timeout=0.05)])))
    searches = []
    def search(text, *args):
        searches.append(text)
        if lookup == 'error': raise RuntimeError('simulated retrieval unavailable')
        return {'results': [{'score': 0.99, 'answer': '问答库原文。', 'question': text}]} if lookup == 'hit' else {'results': []}
    monkeypatch.setattr(server.qa_index, 'search', search)
    warm_tasks, asrs, llms = [], [], []
    texts = iter(['请介绍事务隔离级别', '我负责数据库优化'])
    def stt(*args, **kwargs):
        instance = FakeASR(next(texts), warm_tasks); asrs.append(instance); return instance
    def llm(*args, **kwargs):
        instance = FakeLLM(); llms.append(instance); return instance
    async def warm_qa():
        warm_tasks.append(asyncio.current_task()); await asyncio.Event().wait()
    monkeypatch.setattr(server, 'build_stt', stt); monkeypatch.setattr(server, 'build_llm', llm)
    monkeypatch.setattr(server, '_warm_qa_model', warm_qa)

    async def exercise():
        peers, connections, tasks, tones, messages = [], [], [], [], [[], []]
        try:
            for i, mode in enumerate(['live', 'listen']):
                peer = RTCPeerConnection(RTCConfiguration(iceServers=[])); peers.append(peer)
                tone = Tone(); tones.append(tone); peer.addTrack(tone)
                channel = peer.createDataChannel('rtvi')
                @channel.on('open')
                def opened(channel=channel):
                    channel.send(json.dumps({'label':'rtvi-ai','type':'client-ready','id':'test'}))
                @channel.on('message')
                def received(message, i=i):
                    if isinstance(message, str) and message.startswith('{'): messages[i].append(json.loads(message))
                await peer.setLocalDescription(await peer.createOffer())
                connection = SmallWebRTCConnection(ice_servers=[]); connections.append(connection)
                await connection.initialize(peer.localDescription.sdp, peer.localDescription.type)
                transport = SmallWebRTCTransport(connection, TransportParams(audio_in_enabled=True, audio_out_enabled=True))
                task = asyncio.create_task(server.run_bot(transport, RunnerArguments(body={'mode':mode,'interviewId':'dual-lane-test'})))
                tasks.append(task)
                answer = connection.get_answer()
                await peer.setRemoteDescription(RTCSessionDescription(sdp=answer['sdp'], type=answer['type']))
                # Ensure deterministic factory assignment, without relying on a sleep duration.
                async with asyncio.timeout(5):
                    while len(asrs) <= i: await asyncio.sleep(0.01)
            async with asyncio.timeout(12):
                while True:
                    rows = sessions.connect().execute('SELECT id FROM sessions').fetchall()
                    detail = sessions.get_session(rows[0]['id']) if rows else None
                    turns = detail['turns'] if detail else []
                    if any(t['role']=='ai' for t in turns) and any(t['role']=='candidate' for t in turns): break
                    for task in tasks:
                        if task.done(): task.result()
                    await asyncio.sleep(0.02)
            assert len(asrs) == 2 and len(llms) == 1
            assert all(a.received and all(rate == 16000 and channels == 1 for rate, channels, _ in a.received) for a in asrs)
            assert all(any(nonzero for _, _, nonzero in a.received) for a in asrs)
            assert [t['text'] for t in turns if t['role']=='interviewer'] == ['请介绍事务隔离级别']
            assert [t['text'] for t in turns if t['role']=='candidate'] == ['我负责数据库优化']
            ai = [t for t in turns if t['role']=='ai']; assert len(ai) == 1
            assert ai[0]['source'] == ('qa' if lookup == 'hit' else 'llm')
            assert bool(llms[0].calls) == (lookup != 'hit')
            assert searches == ['请介绍事务隔离级别']
            # Graceful peer disconnect and runner finally must not add duplicate history.
            if lookup == "hit": sessions.mark_completed("dual-lane-test")
            await asyncio.gather(*(p.close() for p in peers))
            await asyncio.wait_for(asyncio.gather(*tasks), 8)
            final = sessions.get_session(detail['id'])
            assert final['status'] == ('completed' if lookup == 'hit' else 'interrupted')
            assert sessions.list_sessions()['total'] == 1
            assert final['turns'] == turns
            assert len(warm_tasks) == 3 and all(t.done() for t in warm_tasks)
            assert all(any(m.get('type') == 'user-transcription' for m in lane) for lane in messages)
            assert any(m.get('type') == 'bot-output' for m in messages[0])
            assert not any(m.get('type') == 'bot-output' for m in messages[1])
        finally:
            for tone in tones: tone.stop()
            await asyncio.gather(*(p.close() for p in peers), return_exceptions=True)
            await asyncio.gather(*(c.disconnect() for c in connections), return_exceptions=True)
            for task in tasks:
                if not task.done(): task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    try: asyncio.run(exercise())
    finally: sessions.reset_cache(); terms.reset_cache()
