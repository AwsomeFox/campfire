import { createZodDto } from 'nestjs-zod';
import {
  SetupRequest,
  LoginRequest,
  SignupRequest,
  PasswordChange,
  AuthTokenRequest,
  PasswordResetRequestCreate,
  PasswordResetConfirm,
} from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131).
export class SetupRequestDto extends createZodDto(SetupRequest.strict()) {}
export class LoginRequestDto extends createZodDto(LoginRequest.strict()) {}
export class SignupRequestDto extends createZodDto(SignupRequest.strict()) {}
export class PasswordChangeDto extends createZodDto(PasswordChange.strict()) {}
export class AuthTokenRequestDto extends createZodDto(AuthTokenRequest.strict()) {}
export class PasswordResetRequestCreateDto extends createZodDto(PasswordResetRequestCreate.strict()) {}
export class PasswordResetConfirmDto extends createZodDto(PasswordResetConfirm.strict()) {}
