/**
 * Visual badge for an audit-log entry's `actorRole`.
 *
 * Issue #526: server-scoped admin actions are now attributed `actorRole:
 * 'admin'` (distinct from a campaign DM's `'dm'`), so an incident reviewer
 * scanning the server-wide audit log can tell a privileged operator action
 * from an ordinary campaign-DM's at a glance. This badge renders that
 * distinction: a labelled "Server admin" chip for the admin sentinel, and a
 * muted role tag for the campaign-scoped roles.
 *
 * Campaign-scoped audit views (e.g. MembersPage's per-campaign audit list)
 * only ever see dm/player/viewer rows — an admin's server-scoped actions are
 * not tied to a campaign — so this badge's `admin` branch only fires on the
 * server-wide admin surfaces. It is still defensive: an unknown value falls
 * back to a neutral tag rather than blowing up the render.
 */
import type { AuditActorRole } from '@campfire/schema';

export function ActorRoleBadge({ role }: { role: AuditActorRole }) {
  if (role === 'admin') {
    return (
      <span
        className="tag"
        title="Server admin — a privileged operator action (server-scoped)"
        style={{ fontSize: 9, background: 'rgb(120 53 15 / 0.4)', color: 'rgb(252 211 77)' }}
      >
        Server admin
      </span>
    );
  }
  // Campaign-scoped roles: muted neutral tag. dm/player/viewer only appear on
  // campaign audit rows; the server-wide log shows them for completeness when
  // a campaign-scoped action bubbles into recent activity.
  const label = role === 'dm' ? 'DM' : role === 'player' ? 'Player' : role === 'viewer' ? 'Viewer' : role;
  return (
    <span className="tag tag-neutral" title={`Campaign role: ${role}`} style={{ fontSize: 9 }}>
      {label}
    </span>
  );
}
