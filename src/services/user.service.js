import { db } from '../config/firebase.js';
import { FieldValue } from 'firebase-admin/firestore';

const usersCollection = db.collection('users');

// --- Configuración ---
const CODE_EXPIRATION_MINUTES = 5; // El código expira en 5 minutos
const MAX_CODE_REQUESTS = 3; // Máximo 3 solicitudes
const CODE_REQUESTS_TIMEFRAME_MINUTES = 15; // en un periodo de 15 minutos

/**
 * Busca un usuario por su número de teléfono.
 * El número de teléfono se usa como ID del documento en Firestore.
 * @param {string} phone - El número de teléfono.
 * @returns {Promise<FirebaseFirestore.DocumentSnapshot>} El snapshot del documento.
 */
export const findUserByPhone = async (phone) => {
  return await usersCollection.doc(phone).get();
};

/**
 * Crea un nuevo usuario en Firestore con la información de la solicitud de código.
 * @param {string} phone - El número de teléfono.
 * @param {string} code - El código de verificación.
 * @returns {Promise<object>} El nuevo usuario creado.
 */
export const createUser = async (phone, code) => {
  const newUser = {
    phone_number: phone,
    whatsapp_verified: false,
    created_at: FieldValue.serverTimestamp(),
    verification_code: code,
    code_created_at: FieldValue.serverTimestamp(),
    code_requests: [FieldValue.serverTimestamp()], // Array para registrar los intentos
  };
  await usersCollection.doc(phone).set(newUser);
  return newUser;
};

/**
 * Actualiza el código de verificación y registra el intento.
 * @param {string} phone - El número de teléfono.
 * @param {string} code - El nuevo código de verificación.
 */
export const updateVerificationCode = async (phone, code) => {
  await usersCollection.doc(phone).update({
    verification_code: code,
    code_created_at: FieldValue.serverTimestamp(),
    code_requests: FieldValue.arrayUnion(FieldValue.serverTimestamp()),
  });
};

/**
 * Verifica si un usuario puede solicitar un nuevo código basándose en los límites de tiempo y cantidad.
 * @param {string} phone - El número de teléfono del usuario.
 * @returns {Promise<boolean>} - True si puede solicitar un código, false si no.
 */
export const canRequestCode = async (phone) => {
  const userDoc = await findUserByPhone(phone);
  if (!userDoc.exists) {
    return true; // Si el usuario no existe, puede solicitarlo.
  }

  const userData = userDoc.data();
  const requests = userData.code_requests || [];

  // Filtramos las solicitudes que están dentro de la ventana de tiempo.
  const timeframe = new Date();
  timeframe.setMinutes(timeframe.getMinutes() - CODE_REQUESTS_TIMEFRAME_MINUTES);

  const recentRequests = requests.filter(
    (timestamp) => timestamp.toDate() > timeframe
  );

  // Purgamos el array de solicitudes en la base de datos para no almacenar datos viejos.
  // Esto se puede hacer de forma asíncrona sin esperar a que termine.
  if (recentRequests.length < requests.length) {
     usersCollection.doc(phone).update({ code_requests: recentRequests });
  }

  return recentRequests.length < MAX_CODE_REQUESTS;
};

/**
 * Verifica a un usuario comparando el código y el teléfono.
 * Si es correcto, lo marca como verificado.
 * También comprueba si el código ha expirado.
 * @param {string} phone - El número de teléfono.
 * @param {string} code - El código de verificación a comprobar.
 * @returns {Promise<object|null>} Los datos del usuario si la verificación es exitosa, o null si falla.
 */
export const verifyUser = async (phone, code) => {
  const userDoc = await findUserByPhone(phone);

  if (!userDoc.exists) {
    return null; // El usuario no existe
  }

  const userData = userDoc.data();
  const { verification_code, code_created_at } = userData;

  // 1. Comprobar si el código ha expirado
  if (code_created_at) {
    const now = new Date();
    const codeTime = code_created_at.toDate();
    const diffMinutes = (now.getTime() - codeTime.getTime()) / (1000 * 60);

    if (diffMinutes > CODE_EXPIRATION_MINUTES) {
      console.log(`Código para ${phone} ha expirado.`);
      return null; // El código ha expirado
    }
  } else {
    return null; // No hay fecha de creación del código
  }

  // 2. Comprobar si el código es correcto
  if (verification_code !== code) {
    return null; // El código no coincide
  }

  // 3. El código es correcto y no ha expirado, actualizamos al usuario
  await usersCollection.doc(phone).update({
    whatsapp_verified: true,
    verification_code: null,
    code_created_at: null,
  });

  return userData;
};

/**
 * Valida la sesión de un usuario que ya ha sido verificado.
 * @param {string} phone - El número de teléfono del usuario.
 * @returns {Promise<object|null>} - Los datos del usuario si la sesión es válida, o null si no.
 */
export const validateSession = async (phone) => {
  const userDoc = await findUserByPhone(phone);

  if (userDoc.exists && userDoc.data().whatsapp_verified) {
    return userDoc.data();
  }

  return null;
};