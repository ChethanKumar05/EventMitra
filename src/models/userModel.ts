import { query } from '../config/database';
import { generateId } from '../utils/id';

export interface UserRow {
  user_id: string;
  user_code: string;
  user_name: string;
  user_phone_number: string;
  country_code: string;
  email: string | null;
  status: string;
  is_active: boolean;
}

export async function findUserById(userId: string): Promise<UserRow | null> {
  const rows = await query<UserRow>(
    'SELECT user_id, user_code, user_name, user_phone_number, country_code, email, status, is_active FROM public."user" WHERE user_id = $1',
    [userId],
  );
  return rows[0] ?? null;
}

// Business validation, OTP checks, and authorization belong in the service layer.
export async function createUser(input: {
  user_code: string; country_code: string; user_phone_number: string;
  user_name: string; email?: string;
}): Promise<UserRow> {
  const rows = await query<UserRow>(`
    INSERT INTO public."user"
      (user_id, user_code, country_code, user_phone_number, user_name, email)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING user_id, user_code, user_name, user_phone_number, country_code, email, status, is_active
  `, [generateId(), input.user_code, input.country_code, input.user_phone_number, input.user_name, input.email ?? null]);
  return rows[0]!;
}
