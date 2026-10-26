import { ListQuery } from './list';
import { SecurityActor } from '../security/types';

export type PersonKind = 'user' | 'owner';
export type ManagementAction = 'read' | 'create' | 'edit' | 'delete';
export type ProfileInput = Record<string, string | number | boolean | null>;
export type AccountInput = Record<string, string | boolean | null>;
export interface ManagementListQuery extends ListQuery { filters: Record<string, string>; }
export type AccountActor = { type: 'admin'; actor: SecurityActor } | { type: PersonKind; id: string; token: string };

export const profileListColumns = {
  user: ['user_id', 'user_code', 'user_name', 'country_code', 'user_phone_number', 'email', 'gender', 'status', 'is_active', 'is_phone_number_verified', 'created_at', 'updated_at'],
  owner: ['owner_id', 'owner_code', 'owner_name', 'country_code', 'owner_phone_number', 'email', 'gender', 'status', 'kyc_verification', 'is_phone_number_verified', 'is_email_verified', 'city', 'state', 'area', 'created_at', 'updated_at'],
} as const;
export const accountFields = ['account_number', 'branch_address', 'passbook_image', 'ifsc_code', 'branch_name', 'account_holder_name', 'is_default'] as const;
export const accountListColumns = ['account_number', 'branch_address', 'ifsc_code', 'branch_name', 'account_holder_name', 'is_default', 'created_at', 'updated_at'] as const;
