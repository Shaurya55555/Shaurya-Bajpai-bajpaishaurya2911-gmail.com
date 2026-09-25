import React, { useEffect, useState } from 'react';
import { get, post, patch, del } from '../api.js';

// A permission-gated element. Present with data-state="unlocked" when held; otherwise
// not rendered at all — never disabled (UI-INVENTORY.md §1).
function Action({ permission, decision, testId, children, onClick }) {
  if (decision?.effect !== 'allow') return null;
  return (
    <button data-testid={testId} data-permission={permission} data-state="unlocked" onClick={onClick} style={{ marginRight: 6 }}>
      {children}
    </button>
  );
}

export function DevicesView({ token, orgId, permissions, refreshSession }) {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  async function load() {
    try {
      const { devices } = await get(`/orgs/${orgId}/devices`, token);
      setDevices(devices);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, [orgId]);

  async function startSession(deviceId, mode) {
    try {
      await post(`/orgs/${orgId}/sessions`, token, { deviceId, mode });
      setStatus(`${mode} session started`);
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function renameDevice(device) {
    const name = window.prompt('New device name', device.name);
    if (!name) return;
    await patch(`/orgs/${orgId}/devices/${device.id}`, token, { name });
    load();
  }

  async function decommission(device) {
    if (!window.confirm(`Decommission ${device.name}?`)) return;
    await del(`/orgs/${orgId}/devices/${device.id}`, token);
    load();
  }

  async function addDevice() {
    const name = window.prompt('Device name');
    if (!name) return;
    const kind = window.prompt('Kind (macos, windows, linux, android, ios)', 'linux');
    if (!kind) return;
    await post(`/orgs/${orgId}/devices`, token, { name, kind });
    load();
  }

  if (error) return <p role="alert">{error}</p>;
  if (!devices) return null;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Devices</h2>
        {permissions['device:provision']?.effect === 'allow' && (
          <button data-testid="add-device" onClick={addDevice}>
            + Add device
          </button>
        )}
      </div>

      {status && <p style={{ color: '#5b6270' }}>{status}</p>}

      {devices.length === 0 ? (
        <p data-testid="devices-empty">No devices yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {devices.map((d) => (
              <tr data-testid="device-row" data-device-id={d.id} key={d.id} style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                <td style={{ padding: '8px 4px' }}>
                  {d.name} <span style={{ color: '#98a2b3', fontSize: 12 }}>({d.kind}{d.online ? ', online' : ''})</span>
                </td>
                <td style={{ padding: '8px 4px' }}>
                  <Action permission="device:view" decision={d.permissions['device:view']} testId="start-view" onClick={() => startSession(d.id, 'view')}>
                    View
                  </Action>
                  <Action permission="device:control" decision={d.permissions['device:control']} testId="start-control" onClick={() => startSession(d.id, 'control')}>
                    Control
                  </Action>
                  <Action permission="device:terminal" decision={d.permissions['device:terminal']} testId="start-terminal" onClick={() => startSession(d.id, 'terminal')}>
                    Terminal
                  </Action>
                  <Action permission="device:file_transfer" decision={d.permissions['device:file_transfer']} testId="transfer-files">
                    Transfer files
                  </Action>
                  <Action permission="device:update" decision={d.permissions['device:update']} testId="rename-device" onClick={() => renameDevice(d)}>
                    Rename
                  </Action>
                  <Action permission="device:provision" decision={d.permissions['device:provision']} testId="decommission-device" onClick={() => decommission(d)}>
                    Decommission
                  </Action>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
