import { json } from '@sveltejs/kit';

export async function GET({ url }) {
  const originLat = url.searchParams.get('origin_lat');
  const originLon = url.searchParams.get('origin_lon');
  const destLat = url.searchParams.get('dest_lat');
  const destLon = url.searchParams.get('dest_lon');
  const departureTime = url.searchParams.get('departure_time');

  const BACKEND_URL = process.env.VITE_API_URL || 'http://localhost:5002';
  
  try {
    const response = await fetch(
      `${BACKEND_URL}/navigate?origin_lat=${originLat}&origin_lon=${originLon}&dest_lat=${destLat}&dest_lon=${destLon}&departure_time=${departureTime}`
    );
    const data = await response.json();
    return json(data);
  } catch (error) {
    console.error('Navigation proxy error:', error);
    return json({ error: 'Failed to fetch navigation' }, { status: 500 });
  }
}