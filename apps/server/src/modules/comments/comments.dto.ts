import { createZodDto } from 'nestjs-zod';
import {
  Comment,
  CommentCreate,
  CommentInboxPage,
  CommentReplyPage,
  CommentThreadMarkRead,
  CommentThreadPage,
  CommentThreadState,
  CommentThreadStateUpdate,
  CommentUnreadSummary,
  CommentUpdate,
  ExpectedUpdatedAt,
} from '@campfire/schema';

// .strict() at the DTO layer (mirrors notes.dto.ts): an unrecognized body key
// 400s instead of being silently stripped and written as a partial create/update.
export class CommentCreateDto extends createZodDto(CommentCreate.strict()) {}
export class CommentUpdateDto extends createZodDto(CommentUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}
export class CommentDto extends createZodDto(Comment) {}
export class CommentThreadPageDto extends createZodDto(CommentThreadPage) {}
export class CommentReplyPageDto extends createZodDto(CommentReplyPage) {}

// Issue #829 — per-thread Watch/Mute/read-state surfaces.
export class CommentThreadStateDto extends createZodDto(CommentThreadState) {}
export class CommentThreadStateUpdateDto extends createZodDto(CommentThreadStateUpdate) {}
export class CommentThreadMarkReadDto extends createZodDto(CommentThreadMarkRead) {}
export class CommentUnreadSummaryDto extends createZodDto(CommentUnreadSummary) {}
export class CommentInboxPageDto extends createZodDto(CommentInboxPage) {}
