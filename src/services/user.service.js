import { db } from '../config/firebase.js';
import { FieldValue } from 'firebase-admin/firestore';
import { sendLimitError } from './whatsapp.service.js';

const usersCollection = db.collection('autenticated_users');

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
 * Crea un nuevo usuario en Firestore.
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
    code_request_timestamps: [],
  };
  await usersCollection.doc(phone).set(newUser);
  return newUser;
};

/**
 * Actualiza el código de verificación de un usuario.
 * @param {string} phone - El número de teléfono.
 * @param {string} code - El nuevo código de verificación.
 */
export const updateVerificationCode = async (phone, code) => {
  await usersCollection.doc(phone).update({
    verification_code: code,
    code_created_at: FieldValue.serverTimestamp(),
  });
};

/**
 * Verifica si un usuario puede solicitar un nuevo código.
 * Limita las solicitudes a `MAX_CODE_REQUESTS` en los últimos `CODE_REQUESTS_TIMEFRAME_MINUTES`.
 * @param {string} phone - El número de teléfono del usuario.
 * @returns {Promise<boolean>} - True si puede solicitar un código, false si no.
 */
export const canRequestCode = async (phone) => {
  const userDocRef = usersCollection.doc(phone);

  try {
    const canRequest = await db.runTransaction(async (transaction) => {
      const userDoc = await transaction.get(userDocRef);

      // Si el usuario no existe, se permite la solicitud.
      // El controlador se encargará de crearlo.
      if (!userDoc.exists) {
        return true;
      }

      const userData = userDoc.data();
      const requestTimestamps = userData.code_request_timestamps || [];

      const now = new Date();
      const timeframeStart = new Date(
        now.getTime() - CODE_REQUESTS_TIMEFRAME_MINUTES * 60 * 1000
      );

      // Filtra los timestamps que están dentro de la ventana de tiempo.
      const recentRequests = requestTimestamps.filter(
        (timestamp) => timestamp.toDate() > timeframeStart
      );

      // Si se ha alcanzado el límite, no se permite la solicitud.
      if (recentRequests.length >= MAX_CODE_REQUESTS) {
         await sendLimitError(phone);
        console.log(`Límite de solicitudes de código excedido para ${phone}.`);
        return false;
      }

      // Añade el nuevo timestamp de solicitud.
      // Usamos new Date() porque FieldValue.serverTimestamp() no puede ser usado en un array.
      // Firestore convertirá el objeto Date a un Timestamp.
      const newTimestamps = [...recentRequests, new Date()];

      transaction.update(userDocRef, {
        code_request_timestamps: newTimestamps,
      });

      return true; // La transacción fue exitosa, se permite la solicitud.
    });

    return canRequest;
  } catch (error) {
    // Para cualquier otro error en la transacción, se deniega por seguridad.
    console.error(
      `Error en la transacción de 'canRequestCode' para ${phone}:`,
      error
    );
    return false;
  }
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