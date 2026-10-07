// src/config/jwt.js
import 'dotenv/config';

export const JWT_SECRET = process.env.JWT_SECRET;
export const JWT_EXPIRATION = '30d';
