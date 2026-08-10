/**
 * Personal navigation client helpers (issue #840) — private bookmarks and bounded
 * recent history. Server-enforced filtering (hidden / deleted / cross-campaign /
 * lost-membership) means the lists returned here are already role-safe; the client
 * only renders what the server sends.
 */
import type {
  Bookmark,
  BookmarkEntityType,
  BookmarksResponse,
  RecentHistoryResponse,
} from '@campfire/schema';
import { api, API } from './api';

export type { Bookmark, BookmarkEntityType, BookmarksResponse, RecentHistoryResponse };

export async function listBookmarks(campaignId: number): Promise<Bookmark[]> {
  const res = await api.get<BookmarksResponse>(`${API}/me/bookmarks?campaignId=${campaignId}`);
  return res.items;
}

export async function addBookmark(target: { campaignId: number; entityType: BookmarkEntityType; entityId: number }): Promise<Bookmark> {
  return api.post<Bookmark>(`${API}/me/bookmarks`, target);
}

export async function removeBookmark(id: number): Promise<void> {
  await api.delete(`${API}/me/bookmarks/${id}`);
}

export async function listRecent(campaignId: number) {
  const res = await api.get<RecentHistoryResponse>(`${API}/me/recent?campaignId=${campaignId}`);
  return res.items;
}

export async function recordVisit(target: {
  campaignId: number;
  entityType: BookmarkEntityType;
  entityId: number;
}): Promise<void> {
  await api.post(`${API}/me/recent`, target);
}

export async function clearRecent(campaignId: number): Promise<void> {
  await api.delete(`${API}/me/recent?campaignId=${campaignId}`);
}
