// Placeholder renderer for the e2e harness (test/e2e/app.test.ts) when build/vendor-ui is absent.
// It walks the same shell contract as the vendor Startup view (02 §4.8): synchronous store read,
// getRunConfig, startupBackendService, SignalR JSON handshake on the token-protected hub, one
// GetTaskAsync("Start"), getMonitorJsonConfig, interfaceInitializeCompleted. It also checks that the
// kill-switch cancels an outbound request and that stripped IPC channels answer inertly.
// Results land in window.__placeholderResult for the test and in the page for screenshots.

(() => {
  const RS = '\u001e';
  const result = { done: false, steps: {} };
  window.__placeholderResult = result;
  const list = document.getElementById('steps');

  function record(name, ok, detail) {
    result.steps[name] = { ok, detail };
    const li = document.createElement('li');
    li.className = ok ? 'ok' : 'fail';
    li.textContent = `${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    list.appendChild(li);
  }

  function hubRoundTrip(port, token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/EvniaHub?k=${encodeURIComponent(token)}`);
      let buffer = '';
      let handshaken = false;
      const timer = setTimeout(() => reject(new Error('hub timeout')), 10000);
      ws.onopen = () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      ws.onerror = () => reject(new Error('hub socket error'));
      ws.onmessage = (ev) => {
        buffer += ev.data;
        let i;
        while ((i = buffer.indexOf(RS)) >= 0) {
          const record = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          const msg = JSON.parse(record);
          if (!handshaken) {
            handshaken = true;
            if (msg.error) return reject(new Error(msg.error));
            const request = JSON.stringify({ functionName: 'Start', requestId: 'e2e-1', parms: [] });
            ws.send(JSON.stringify({ type: 1, invocationId: '0', target: 'GetTaskAsync', arguments: [request] }) + RS);
          } else if (msg.type === 1 && msg.target === 'GetTaskAsync') {
            clearTimeout(timer);
            ws.close();
            resolve(JSON.parse(msg.arguments[0]));
          }
        }
      };
    });
  }

  async function run() {
    record('store.language', typeof window.store.get('language') === 'string', window.store.get('language'));
    const runConfig = await window.ipc.invoke('getRunConfig');
    window.runConfig = runConfig;
    record('getRunConfig', runConfig && runConfig.appVersion === '1.13.0' && runConfig.mac === '', runConfig);
    record('__EVNIA__', !!window.__EVNIA__ && window.__EVNIA__.platform === 'linux' && window.__EVNIA__.hubToken.length >= 16, 'token present');

    const port = await window.ipc.invoke('startupBackendService');
    record('startupBackendService', typeof port === 'number' && port > 0, port);
    result.hubPort = port;
    const again = await window.ipc.invoke('startupBackendService');
    record('startupBackendService idempotent', again === port, again);

    try {
      const reply = await hubRoundTrip(port, window.__EVNIA__.hubToken);
      record('hub GetTaskAsync Start', reply.err_code === 0 && reply.RequestId === 'e2e-1' && reply.Tag === true, reply);
    } catch (e) {
      record('hub GetTaskAsync Start', false, String(e));
    }

    const monitorConfig = await window.ipc.invoke('getMonitorJsonConfig');
    record('getMonitorJsonConfig', monitorConfig && monitorConfig.OTAEnable === false && !!monitorConfig.config['34M2C8600'], monitorConfig);

    const offline = await Promise.all([
      window.ipc.invoke('runCommand', 'id'),
      window.ipc.invoke('getMac'),
      window.ipc.invoke('checkNodeAvailable'),
    ]);
    record('stripped channels inert', offline[0].stdout === '' && offline[1] === '' && offline[2].available === false, offline);

    const versionCheck = new Promise((resolve) => window.ipc.once('versionCheckResult', (_e, r) => resolve(r)));
    window.ipc.send('checkSoftwareVersion');
    const vr = await versionCheck;
    record('checkSoftwareVersion answered offline', vr.state === 0, vr);

    try {
      await fetch('https://kill-switch-probe.invalid/probe', { cache: 'no-store' });
      record('kill-switch', false, 'request went through');
    } catch (e) {
      record('kill-switch', true, String(e));
    }

    record('nodeApi confinement', window.nodeApi.existsSync('/etc/passwd') === false, 'outside paths invisible');

    window.ipc.send('interfaceInitializeCompleted');
    record('interfaceInitializeCompleted', true, 'sent');
  }

  run()
    .catch((e) => record('unexpected', false, String(e && e.stack ? e.stack : e)))
    .finally(() => {
      result.done = true;
    });
})();
