import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter(),
		paths: {
			base: ''
		}
	},

	vite: {
		server: {
			fs: {
				allow: ['.', '/home/atanas/Desktop/mysofia_FE']
			}
		}
	}
};

export default config;