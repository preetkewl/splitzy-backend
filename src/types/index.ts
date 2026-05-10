// Side-effect import to register Express type augmentations.
// Module that needs `req.user` typed should import this file (or any
// other module already does — `app.ts`).
import './express.js';

export {};
