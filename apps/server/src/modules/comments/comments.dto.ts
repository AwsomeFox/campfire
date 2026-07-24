import { createZodDto } from 'nestjs-zod';
import { Comment, CommentCreate, CommentUpdate, ExpectedUpdatedAt } from '@campfire/schema';

// .strict() at the DTO layer (mirrors notes.dto.ts): an unrecognized body key
// 400s instead of being silently stripped and written as a partial create/update.
export class CommentCreateDto extends createZodDto(CommentCreate.strict()) {}
export class CommentUpdateDto extends createZodDto(CommentUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}
export class CommentDto extends createZodDto(Comment) {}
