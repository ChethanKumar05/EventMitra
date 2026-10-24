import * as service from '../services/userAuthService';
import { userCookieName, userCookieOptions, userSessionToken } from '../middleware/userAuth';
import { success } from '../utils/response';
import { handler } from './securityValidation';
import { userOtpInput, userPhoneInput, userSignupInput } from './userValidation';

export const signup = handler(async (req, res) => {
  success(res, 'User registered. Request a login OTP to verify your phone.', await service.signupUser(userSignupInput(req.body), req.ip ?? ''), 201);
});

export const login = handler(async (req, res) => {
  success(res, 'If the account is eligible, a test OTP challenge is available', await service.issueUserOtp(userPhoneInput(req.body), req.ip ?? ''));
});

export const resendOtp = handler(async (req, res) => {
  success(res, 'If the account is eligible, a new test OTP challenge is available', await service.issueUserOtp(userPhoneInput(req.body), req.ip ?? ''));
});

export const verifyOtp = handler(async (req, res) => {
  const input = userOtpInput(req.body);
  const result = await service.verifyUserOtp(input.otp_token, input.otp, req.ip ?? '');
  res.cookie(userCookieName, result.session, { ...userCookieOptions, maxAge: 8 * 60 * 60 * 1000 });
  success(res, 'User logged in', result.user);
});

export const me = handler(async (_req, res) => {
  success(res, 'Current user', res.locals.user);
});

export const logout = handler(async (req, res) => {
  const token = userSessionToken(req);
  if (token) await service.logoutUser(token);
  res.clearCookie(userCookieName, userCookieOptions);
  success(res, 'User logged out', null);
});
