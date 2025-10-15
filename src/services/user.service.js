import { supabase } from '../config/supabase.js';

export const findUserByPhone = async (phone) => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone_number', phone)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
};

export const createUser = async (phone, code) => {
  const { data, error } = await supabase
    .from('users')
    .insert([{ phone_number: phone, verification_code: code }])
    .select()
    .single();

  if (error) throw error;
  return data;
};

export const updateVerificationCode = async (phone, code) => {
  const { data, error } = await supabase
    .from('users')
    .update({ verification_code: code })
    .eq('phone_number', phone)
    .select()
    .single();

  if (error) throw error;
  return data;
};

export const verifyUser = async (phone, code) => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('phone_number', phone)
    .eq('verification_code', code)
    .single();

  if (error || !data) return null;

  const { error: updateError } = await supabase
    .from('users')
    .update({ whatsapp_verified: true, verification_code: null })
    .eq('phone_number', phone);

  if (updateError) throw updateError;
  return data;
};
