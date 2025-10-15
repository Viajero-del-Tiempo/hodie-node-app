import express from 'express';
import bodyParser from 'body-parser';
import { router as authRouter } from './routes/auth.routes.js';

const app = express();
app.use(bodyParser.json());
app.use('/auth', authRouter);

export default app;
