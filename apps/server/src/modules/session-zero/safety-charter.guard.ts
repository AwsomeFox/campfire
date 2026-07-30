import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { SafetyCharterValidator } from './safety-charter-validator';

@Injectable()
export class SafetyCharterGuard implements CanActivate {
  private readonly logger = new Logger(SafetyCharterGuard.name);

  constructor(private readonly validator: SafetyCharterValidator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const body = request.body;
    
    // We only validate endpoints that modify content (POST/PATCH/PUT) and have text fields.
    if (!body || typeof body !== 'object') return true;
    
    // Extract text that might violate charter (e.g. from notes, comments, input, body, text fields)
    const textToValidate = body.body || body.text || body.input || body.content || body.description;
    if (!textToValidate || typeof textToValidate !== 'string') return true;

    // We need the campaign ID to lookup the charter
    const campaignId = parseInt(request.params.campaignId || request.params.id, 10);
    if (isNaN(campaignId)) return true;

    try {
      const result = await this.validator.validateContent(campaignId, textToValidate);
      if (result.violates) {
        throw new ForbiddenException(`Content violates session-zero safety charter: ${result.reason || 'Safety limits hit.'}`);
      }
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      this.logger.error(`Safety validation failed for campaign ${campaignId}`, err);
    }
    return true;
  }
}
