import { SearchResponse } from '@campfire/schema';
import { createZodDto } from 'nestjs-zod';

/** OpenAPI response contract for campaign search. */
export class SearchResponseDto extends createZodDto(SearchResponse) {}
