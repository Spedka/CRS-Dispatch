import { Hono } from 'hono';
import { api } from './routes.js';

const app = new Hono();
app.route('/api', api);

export default app; // Hono exposes { fetch }, which is the Worker entrypoint