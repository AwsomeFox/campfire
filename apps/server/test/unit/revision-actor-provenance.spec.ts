import { revisionActorProvenance } from '../../src/modules/revisions/revisions.service';
import type { RequestUser } from '../../src/common/user.types';

describe('revisionActorProvenance (#813)', () => {
  it('labels ordinary cookie users as human', () => {
    const user: RequestUser = { id: 'dev:alice', name: 'alice', serverRole: 'user' };
    expect(revisionActorProvenance(user)).toEqual({
      userId: 'dev:alice',
      name: 'alice',
      source: 'human',
      sourceDetail: '',
    });
  });

  it('labels PAT actors as tool with the token name as detail', () => {
    const user: RequestUser = {
      id: '42',
      name: 'Morgan',
      serverRole: 'user',
      tokenContext: {
        tokenId: 7,
        name: 'mcp-claude',
        scope: 'dm',
        writeScope: 'direct',
        campaignId: 1,
        adminEnabled: false,
      },
    };
    expect(revisionActorProvenance(user)).toEqual({
      userId: '42',
      name: 'Morgan',
      source: 'tool',
      sourceDetail: 'mcp-claude',
    });
  });

  it('labels AI seat principals as ai (even when they also carry tokenContext)', () => {
    const user: RequestUser = {
      id: 'ai-dm-seat:3',
      name: 'AI Dungeon Master',
      serverRole: 'user',
      tokenContext: {
        tokenId: 0,
        name: 'ai-dm-seat:3',
        scope: 'dm',
        writeScope: 'direct',
        campaignId: 3,
        adminEnabled: false,
      },
      proposalAttribution: {
        proposer: 'AI Dungeon Master (driver)',
        proposerUserId: 'ai-dm:3',
        proposerToken: null,
      },
    };
    expect(revisionActorProvenance(user)).toEqual({
      userId: 'ai-dm:3',
      name: 'AI Dungeon Master (driver)',
      source: 'ai',
      sourceDetail: 'ai-dm-seat:3',
    });
  });
});
