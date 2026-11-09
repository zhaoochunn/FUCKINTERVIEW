import test from 'node:test';
import assert from 'node:assert/strict';
import { startBotParams } from '../src/lib/session-request.ts';

test('SmallWebRTC start requests keep the shared interview ID and distinct runner body modes', () => {
  const system = startBotParams('live', { interviewId: 'test-interview', profileId: 'test-profile' });
  const mic = startBotParams('listen', { interviewId: 'test-interview' });
  assert.equal(system.endpoint, '/start'); assert.equal(mic.endpoint, '/start');
  assert.deepEqual(system.requestData, { transport: 'webrtc', createDailyRoom: false, enableDefaultIceServers: false,
    body: { mode: 'live', interviewId: 'test-interview', profileId: 'test-profile' } });
  assert.deepEqual(mic.requestData, { transport: 'webrtc', createDailyRoom: false, enableDefaultIceServers: false,
    body: { mode: 'listen', interviewId: 'test-interview' } });
});
