import { db } from "../config/firebase.js";
import { Timestamp } from "firebase-admin/firestore";
import { createProfileService } from "../services/profile.service.js";
import { analyzeRuc } from "../utils/ruc.util.js";
import { sendCustomerError } from "../utils/customer-data.util.js";

export const profileService = createProfileService({ db, timestampNow: () => Timestamp.now() });
export function createUserController(profile = profileService) {
  return {
    async getMyProfile(req, res) {
      try { return res.json({ success: true, user: await profile.get(req.userPhone) }); }
      catch (error) { return sendCustomerError(res, error); }
    },
    async updateMyProfile(req, res) {
      try { return res.json({ success: true, user: await profile.update(req.userPhone, req.body), message: "Perfil actualizado correctamente" }); }
      catch (error) { return sendCustomerError(res, error); }
    },
    validateRuc(req, res) {
      try { return res.json({ success: true, ...analyzeRuc(req.body?.ruc) }); }
      catch (error) { return sendCustomerError(res, error); }
    },
  };
}
