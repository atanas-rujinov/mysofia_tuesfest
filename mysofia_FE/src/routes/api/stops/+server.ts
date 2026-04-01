import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const API_URL = import.meta.env.VITE_API_URL;

export const GET: RequestHandler = async () => {
	if (!API_URL) {
		return json({ error: 'API URL not configured' }, { status: 500 });
	}

	try {
		const response = await fetch(`${API_URL}/stops/`, {
			headers: {
				'ngrok-skip-browser-warning': 'true'
			}
		});

		if (!response.ok) {
			return json(
				{ error: `Backend API returned ${response.status}` },
				{ status: response.status }
			);
		}

		const data = await response.json();
		return json(data);
	} catch (error) {
		console.error('Error fetching stops from backend:', error);
		return json({ error: 'Failed to fetch stops from backend' }, { status: 500 });
	}
};
