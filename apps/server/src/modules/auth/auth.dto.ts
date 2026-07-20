import { createZodDto } from 'nestjs-zod';
import {
  SetupRequest,
  LoginRequest,
  PasswordChange,
  AuthTokenRequest,
  PasswordResetRequestCreate,
  PasswordResetConfirm,
} from '@campfire/schema';

export class SetupRequestDto extends createZodDto(SetupRequest) {}
export class LoginRequestDto extends createZodDto(LoginRequest) {}
export class PasswordChangeDto extends createZodDto(PasswordChange) {}
export class AuthTokenRequestDto extends createZodDto(AuthTokenRequest) {}
export class PasswordResetRequestCreateDto extends createZodDto(PasswordResetRequestCreate) {}
export class PasswordResetConfirmDto extends createZodDto(PasswordResetConfirm) {}
