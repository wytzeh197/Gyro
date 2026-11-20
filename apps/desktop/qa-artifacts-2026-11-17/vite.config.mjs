import original from '../vite.config.ts';
export default (environment) => { const config=original(environment); return {...config,server:{...config.server,hmr:false},optimizeDeps:{...config.optimizeDeps,noDiscovery:true}}; };
