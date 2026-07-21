import express from 'express';
import type { Server } from 'node:http';

/**
 * Minimal fake 13th Age (Archmage Engine) SRD server for tests, run in-process on an
 * ephemeral port. Serves TRIMMED-BUT-REAL HTML captured from www.13thagesrd.com (2026-07):
 * two actual monster statblocks (Bear, Dire Bear) with their real numbers, and the real
 * "Conditions" section markup. This exercises the same HTML-parsing code path the importer
 * runs against the live SRD, without depending on network access in CI — the 13th Age
 * analogue of test/fake-open5e.ts.
 *
 * Structure preserved verbatim from the live site so the parser is proven against reality:
 *  - Monsters: `<h3><span id="Name">Name</span></h3>` + a 4-column statblock `<table>`
 *    (size/level/role/type | Initiative + attacks | AC/PD/MD/HP labels | values). The level
 *    is written "2<sup>nd</sup> level"; defenses are three (AC / PD / MD) plus HP.
 *  - A non-statblock `<h3>` ("Building Combats") is included to prove prose headings are
 *    skipped rather than mis-imported.
 *  - Conditions: `<h3 id="Conditions">` wrapping `<h4><span id="Name">Name</span></h4>` +
 *    `<p>` prose per condition, with an escalation-die `<h3>` sibling that must NOT be
 *    treated as a condition (it's outside the Conditions scope).
 */

const MONSTERS_HTML = `<!doctype html><html><body>
<div id="content">
<h2><span id="Monsters">Monsters</span></h2>
<h3><span id="Building_Combats">Building Combats</span></h3>
<p>A battle is balanced when the total value of the monsters roughly matches the party.</p>
<h3><span id="Bear">Bear</span></h3>
<table border="1" cellspacing="0">
<tbody>
<tr>
<td>
<p><b>Normal</b></p>
<p><b>2<sup>nd</sup>&nbsp;level</b></p>
<p><b>Troop</b></p>
<p><b>Beast</b></p>
</td>
<td>
<p>Initiative: +4</p>
<p><b>Bite +7 vs. AC</b> &#8212; 6 damage<br /> <i>Natural even hit:</i> The target takes +1d6 damage from a claw swipe.</p>
</td>
<td>
<p><b>AC</b></p>
<p><b>PD</b></p>
<p><b>MD</b></p>
<p><b>HP</b></p>
</td>
<td>
<p><b>17</b></p>
<p><b>16</b></p>
<p><b>12</b></p>
<p><b>45</b></p>
</td>
</tr>
</tbody>
</table>
<h3><span id="Dire_Bear">Dire Bear</span></h3>
<table border="1" cellspacing="0">
<tbody>
<tr>
<td>
<p><b>Large</b></p>
<p><b>4<sup>th</sup>&nbsp;level</b></p>
<p><b>Troop</b></p>
<p><b>Beast</b></p>
</td>
<td>
<p>Initiative: +7</p>
<p><b>Bite +8 vs. AC</b> &#8212; 24 damage<br /> <i>Natural even hit:</i> The target takes +2d6 damage from a claw swipe.</p>
<p><i>Savage:</i> The dire bear gains a +2 attack bonus against staggered enemies.</p>
</td>
<td>
<p><b>AC</b></p>
<p><b>PD</b></p>
<p><b>MD</b></p>
<p><b>HP</b></p>
</td>
<td>
<p><b>19</b></p>
<p><b>19</b></p>
<p><b>14</b></p>
<p><b>130</b></p>
</td>
</tr>
</tbody>
</table>
</div>
</body></html>`;

const COMBAT_HTML = `<!doctype html><html><body>
<div id="content">
<h2><span id="Combat_Effects">Combat Effects</span></h2>
<h3><span id="Escalation_Die">Escalation Die</span></h3>
<p>At the start of the second round, the GM sets the escalation die at 1. Each PC gains a bonus to attack rolls equal to the current value on the escalation die.</p>
<h3><span id="Conditions">Conditions</span></h3>
<p>You can only be affected by the same condition once at a time. The worst one affects you and the lesser effects are ignored.</p>
<h4><span id="Confused">Confused</span></h4>
<p>You can&#8217;t make opportunity attacks or use your limited powers. Your next attack action will be a basic or at-will attack against any nearby ally, determined randomly.</p>
<h4><span id="Dazed">Dazed</span></h4>
<p>You take a &#8211;4 penalty to attacks.</p>
<h4><span id="Fear">Fear</span></h4>
<p>Fear dazes you and prevents you from using the escalation die.</p>
<h3><span id="Coup_de_Grace">Coup de Grace</span></h3>
<p>When you attack a helpless enemy you&#8217;re engaged with, you score an automatic critical hit.</p>
</div>
</body></html>`;

export interface FakeArchmage {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

export async function startFakeArchmage(): Promise<FakeArchmage> {
  const app = express();
  app.get('/monsters/', (_req, res) => res.type('html').send(MONSTERS_HTML));
  app.get('/combat-rules/', (_req, res) => res.type('html').send(COMBAT_HTML));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake 13th Age server');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    server,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
