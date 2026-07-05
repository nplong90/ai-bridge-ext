import { chatgptDriver } from "./chatgpt.js";
import { geminiDriver } from "./gemini.js";

// Add a provider = import its driver and add it here. Nothing else changes.
export const DRIVERS = [chatgptDriver, geminiDriver];

export function pickDriver(host) {
  return DRIVERS.find((d) => d.hostMatch(host)) || null;
}

export function driverById(id) {
  return DRIVERS.find((d) => d.id === id) || null;
}

export const DRIVER_META = DRIVERS.map((d) => ({ id: d.id, capabilities: d.capabilities }));
