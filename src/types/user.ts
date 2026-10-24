export interface UserPhone {
  country_code: string;
  user_phone_number: string;
}

export interface UserSignupInput extends UserPhone {
  user_name: string;
  gender: 'm' | 'f';
  email: string | null;
  profile_image: string | null;
  whatsapp_number: string | null;
  alternative_number: string | null;
}

export interface UserIdentity extends UserSignupInput {
  user_id: string;
  user_code: string;
  status: string;
  is_active: boolean;
  is_phone_number_verified: boolean;
}
