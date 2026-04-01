<script lang="ts">
	import { onMount } from "svelte";
  
	let container: HTMLDivElement;
  
	onMount(async () => {
	  if (!container) return;

	  // Import Leaflet only on the client side
	  const L = await import("leaflet");

	  // Fix Leaflet default icon paths (common issue with bundlers)
	  if ((L.Icon.Default.prototype as any)._getIconUrl) {
		delete (L.Icon.Default.prototype as any)._getIconUrl;
	  }
	  L.Icon.Default.mergeOptions({
		iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
		iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
		shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
	  });

	  const map = L.map(container);

	  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
		attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
	  }).addTo(map);

	  map.setView([42.6977, 23.3219], 13); // Sofia

	  // Cleanup on unmount
	  return () => {
		map.remove();
	  };
	});
  </script>
  
  <div bind:this={container} class="map"></div>
  
  <style>
	.map {
	  height: 100%;
	  width: 100%;
	  min-height: 400px;
	}
  </style>
  