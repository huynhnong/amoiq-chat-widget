/**
 * Example component demonstrating how to use the useOnlineUsers hook
 * This is a reference implementation for integrating online users tracking
 * into your admin UI
 */

'use client';

import { useOnlineUsers } from '@/lib/hooks/useOnlineUsers';

interface OnlineUsersExampleProps {
  tenantId: string;
}

/**
 * Example component showing online users list
 * 
 * This demonstrates:
 * - Basic hook usage
 * - Displaying online users list
 * - Handling loading/error states
 * - Real-time updates
 */
export default function OnlineUsersExample({ tenantId }: OnlineUsersExampleProps) {
  const { onlineUsers, isLoading, error, refresh, isConnected } = useOnlineUsers(tenantId);

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ marginBottom: '20px' }}>
        <h2 style={{ margin: '0 0 10px 0' }}>Online Users</h2>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' }}>
          <span style={{ 
            display: 'inline-block',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: isConnected ? '#10b981' : '#ef4444'
          }} />
          <span style={{ fontSize: '14px', color: '#6b7280' }}>
            {isConnected ? 'Connected (Real-time)' : 'Disconnected (Polling)'}
          </span>
          <button
            onClick={refresh}
            style={{
              padding: '4px 12px',
              fontSize: '12px',
              border: '1px solid #d1d5db',
              borderRadius: '4px',
              backgroundColor: 'white',
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          padding: '12px',
          backgroundColor: '#fee2e2',
          border: '1px solid #fecaca',
          borderRadius: '4px',
          color: '#991b1b',
          marginBottom: '16px',
        }}>
          <strong>Error:</strong> {error.message}
        </div>
      )}

      {isLoading && onlineUsers.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#6b7280' }}>
          Loading online users...
        </div>
      ) : onlineUsers.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#6b7280' }}>
          No users online
        </div>
      ) : (
        <div>
          <div style={{ marginBottom: '12px', fontSize: '14px', color: '#6b7280' }}>
            {onlineUsers.length} {onlineUsers.length === 1 ? 'user' : 'users'} online
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {onlineUsers.map((user) => (
              <li
                key={user.userId}
                style={{
                  padding: '12px',
                  marginBottom: '8px',
                  backgroundColor: '#f9fafb',
                  border: '1px solid #e5e7eb',
                  borderRadius: '6px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <div>
                    <div style={{ fontWeight: '600', marginBottom: '4px' }}>
                      {user.userId}
                    </div>
                    {user.domain && (
                      <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '2px' }}>
                        Domain: {user.domain}
                      </div>
                    )}
                    {user.sessionId && (
                      <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '2px' }}>
                        Session: {user.sessionId}
                      </div>
                    )}
                    <div style={{ fontSize: '12px', color: '#9ca3af' }}>
                      Connected: {new Date(user.connectedAt).toLocaleString()}
                    </div>
                  </div>
                  <span style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: '#10b981',
                    marginTop: '4px',
                  }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

