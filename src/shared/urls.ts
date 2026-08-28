/**
 * External web URLs the desktop app links out to. Centralized so a literal
 * never gets scattered across main / preload / renderer — `shell.openExternal`
 * call sites MUST reference one of these constants, never a renderer-supplied
 * or otherwise dynamic string (see threat-model.md: renderer is untrusted).
 */

/** Web-always Mesh device-control surface (E-CONTROL #78b). */
export const DEVICE_CONTROL_URL = 'https://console.wave.online/control/devices';
