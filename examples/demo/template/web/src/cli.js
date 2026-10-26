import { fetchGreeting, renderGreeting } from "./greeting.js";

const baseUrl = process.env.API_URL ?? "http://localhost:3000";
console.log(renderGreeting(await fetchGreeting(baseUrl)));
