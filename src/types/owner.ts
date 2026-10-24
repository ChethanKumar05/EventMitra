export interface OwnerIdentity {
  owner_id:string;
  owner_code:string;
  owner_name:string;
  email:string|null;
  status:'pending'|'verified';
  kyc_verification:boolean;
  is_phone_number_verified:boolean;
}
export interface OwnerLoginInput {
  field:'owner_name'|'email';
  identifier:string;
  password:string;
}
