import express from "express";
import { getHandoffChats, resumeBot } from "../controllers/admin.chat.controller.js";
import { requireAuth, requireAdmin } from "../middlewares/auth.middleware.js";

export const router = express.Router();

router.get("/chats/handoff", requireAuth, requireAdmin, getHandoffChats);
router.post("/chats/:threadId/resume-bot", requireAuth, requireAdmin, resumeBot);
