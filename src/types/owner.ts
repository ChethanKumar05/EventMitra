export interface OwnerIdentity {
  owner_id:string;
  owner_code:string;
  owner_name:string;
  email:string|null;
  status:'pending'|'verified';
  kyc_verification:boolean;
  is_email_verified:boolean;
  is_phone_number_verified:boolean;
}
export interface OwnerLoginInput {
  field:'owner_name'|'email';
  identifier:string;
  password:string;
}
export interface OwnerSignupInput {
  owner_name:string;owner_phone_number:string;country_code:string;email:string;password:string;
  gender:'m'|'f';doc_type:string;doc_number:string;doc_image:string;pin_code:string;
  state:string;city:string;area:string;lat:number;long:number;address:string;
  alternative_number?:string|null;profile_image?:string|null;alternative_email?:string|null;whatsapp_number?:string|null;
}
export type OtpTarget={type:'email';email:string}|{type:'phone';country_code:string;phone_number:string};
export type OtpPurpose='verification'|'password_reset';
