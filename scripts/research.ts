import { observeLaunches } from "../src/observer.js";
console.log(JSON.stringify(await observeLaunches(), null, 2));
