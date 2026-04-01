<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { setOptions, importLibrary } from "@googlemaps/js-api-loader";

  let mapEl: HTMLDivElement;
  let map: google.maps.Map;
  let markers: google.maps.Marker[] = [];
  let vehicleMarkers: google.maps.Marker[] = [];
  let userMarker: google.maps.Marker | null = null;
  let selectedStop: string | null = null;
  let selectedStopCode: string | null = null;
  let selectedMarker: google.maps.Marker | null = null;
  let selectedTripId: string | null = null;
  let futureArrivals: any[] = [];
  let showPopup = false;
  let refreshInterval: number | null = null;
  let vehicleInfoWindow: google.maps.InfoWindow;
  let watchId: number | null = null;

  // Navigation state
  let showNavigation = false;
  let navigationRoutes: any[] = [];
  let selectedRouteIndex: number = 0;
  let userLocation: { lat: number; lng: number } | null = null;
  let navigationPolylines: google.maps.Polyline[] = [];
  let departureTime: string = "";
  let currentNavigationDest: { lat: number; lon: number } | null = null;
  let startPoint: { lat: number; lng: number } | null = null;
  let showStartPointSelector = false;
  let startPointSearchInput: HTMLInputElement | null = null;
  let startPointAutocomplete: any = null;
  let Autocomplete: any = null;
  
  // Real-time info: index -> { primary: {min, status, historic_latency, historic_relationship}, secondary: [{min, status}] }
  let legRealTimeInfo: Record<number, { 
    primary: { minutes: number, status: string, historic_latency?: number, historic_relationship?: string }, 
    secondary: Array<{ minutes: number, status: string }> 
  }> = {};

  interface BusStop {
    stop_id: string;
    stop_code: string;
    stop_name: string;
    stop_lat: number;
    stop_lon: number;
  }

  const iconCache: Record<string, string> = {};

  function getIconSize(zoom: number): number {
    const baseZoom = 13;
    const baseSize = 2;
    const scaleFactor = Math.pow(1.5, zoom - baseZoom);
    return baseSize * scaleFactor;
  }

  function calculateMinutesUntil(scheduledTime: string): number {
    if (!scheduledTime) return 0;
    const [hours, minutes, seconds] = scheduledTime.split(":").map(Number);
    const now = new Date();
    const scheduled = new Date(now);
    
    scheduled.setHours(hours, minutes, seconds || 0, 0);
    if (scheduled.getTime() < now.getTime() - 60_000) {
      scheduled.setDate(scheduled.getDate() + 1);
    }
  
    const diffMs = scheduled.getTime() - now.getTime();
    const result = Math.round(diffMs / 60000);
    if (result>=1440) {
      return result-1440 ;
    }
    else return result;
  }

  function getTransitRouteIds(route: any): string[] {
    if (!route || !route.legs) return [];
    
    const routeIds: string[] = [];
    route.legs.forEach((leg: any) => {
      if (leg.type === 'transit' && leg.route_id) {
        routeIds.push(leg.route_id);
      }
    });
    
    return routeIds;
  }

  function clearVehicleMarkers() {
    vehicleMarkers.forEach(marker => marker.setMap(null));
    vehicleMarkers = [];
  }

  function clearNavigationPolylines() {
    navigationPolylines.forEach(polyline => polyline.setMap(null));
    navigationPolylines = [];
  }

  // Filter Stops + Set Fixed Size for Route
  function filterStopsForRoute(route: any) {
    if (!route || !route.legs) return;

    const relevantStopIds = new Set<string>();

    route.legs.forEach((leg: any) => {
      if (leg.type === 'transit') {
        if (leg.from_stop_id) relevantStopIds.add(leg.from_stop_id);
        if (leg.to_stop_id) relevantStopIds.add(leg.to_stop_id);
      }
      if (leg.type === 'walk') {
        if (leg.from?.stop_id) relevantStopIds.add(leg.from.stop_id);
        if (leg.to?.stop_id) relevantStopIds.add(leg.to.stop_id);
      }
    });

    markers.forEach((marker: any) => {
      if (marker.stopId && relevantStopIds.has(marker.stopId)) {
        marker.setVisible(true);
        // FORCE FIX SIZE (16x16) for navigation stops
        const currentIcon = marker.getIcon() as google.maps.Icon;
        if (currentIcon && currentIcon.url) {
            marker.setIcon({
                url: currentIcon.url,
                scaledSize: new google.maps.Size(16, 16),
                anchor: new google.maps.Point(8, 16)
            });
        }
      } else {
        marker.setVisible(false);
      }
    });
  }

  function closePopup() {
    vehicleInfoWindow?.close();
    showPopup = false;
    selectedStopCode = null;
    selectedTripId = null;
    clearVehicleMarkers();
    if (selectedMarker) {
      const transportType = extractTransportType(selectedMarker.getTitle() || "");
      const iconDataUrl = iconCache[transportType];
      selectedMarker = null;
    }

    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }

    if (showNavigation && navigationRoutes[selectedRouteIndex]) {
        // If still in navigation, re-apply filter (keeps stops big and fixed)
        filterStopsForRoute(navigationRoutes[selectedRouteIndex]);
        if (!refreshInterval) {
             fetchAndShowNavigationVehicles(navigationRoutes[selectedRouteIndex]);
             refreshInterval = setInterval(() => {
                fetchAndShowNavigationVehicles(navigationRoutes[selectedRouteIndex]);
            }, 5000);
        }
    } else {
        // FULL RESET: Restore dynamic size based on current zoom
        const zoom = map.getZoom() || 13;
        const size = getIconSize(zoom);
        markers.forEach(marker => {
            marker.setVisible(true);
            const icon = marker.getIcon() as google.maps.Icon;
            if (icon?.url) {
                marker.setIcon({
                    url: icon.url,
                    scaledSize: new google.maps.Size(size, size),
                    anchor: new google.maps.Point(size / 2, size)
                });
            }
        });
    }
  }

  function closeNavigation() {
    showNavigation = false;
    navigationRoutes = [];
    selectedRouteIndex = 0;
    legRealTimeInfo = {};
    departureTime = "";
    currentNavigationDest = null;
    startPoint = null;
    showStartPointSelector = false;
    clearNavigationPolylines();
    clearVehicleMarkers(); 
    
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }

    const zoom = map.getZoom() || 13;
    const size = getIconSize(zoom);
    
    markers.forEach(marker => {
        marker.setVisible(true);
        const icon = marker.getIcon() as google.maps.Icon;
        if (icon?.url) {
            marker.setIcon({
                url: icon.url,
                scaledSize: new google.maps.Size(size, size),
                anchor: new google.maps.Point(size / 2, size)
            });
        }
    });
  }

  function selectTrip(tripId: string) {
    if (selectedTripId === tripId) {
      selectedTripId = null;
      vehicleMarkers.forEach(marker => marker.setVisible(true));
    } else {
      selectedTripId = tripId;
      vehicleMarkers.forEach(marker => {
        const markerTripId = (marker as any).tripId;
        marker.setVisible(markerTripId === tripId);
      });
    }
  }

  function getVehicleColor(realLifeRouteId: string): string {
    const match = realLifeRouteId?.match(/^[A-Z]{1,2}/);
    const prefix = match ? match[0] : null;

    switch (prefix) {
      case "A": return "#EF4444";
      case "TM": return "#F97316";
      case "TB": return "#3B82F6";
      default: return "#6B7280";
    }
  }

  async function fetchStopArrivals(stopId: string) {
    try {
      const response = await fetch(`/api/stops/${stopId}/future-arrivals`);
      let data = await response.json();

      const dedupedMap = new Map<string, any>();
      vehicleInfoWindow = vehicleInfoWindow || new google.maps.InfoWindow();
      data.forEach((arrival: any) => {
        const key = `${arrival.real_life_route_id}_${arrival.scheduled_arrival_time}`;
        const existing = dedupedMap.get(key);
        if (!existing || (arrival.certainty && !existing.certainty)) {
          dedupedMap.set(key, arrival);
        }
      });
      futureArrivals = Array.from(dedupedMap.values());

      futureArrivals.sort((a, b) => {
        return calculateMinutesUntil(a.expected_arrival_time) - calculateMinutesUntil(b.expected_arrival_time);
      });
      clearVehicleMarkers();

      const tripStillExists = selectedTripId && futureArrivals.some(a => a.trip_id === selectedTripId);
      if (!tripStillExists) selectedTripId = null;
      futureArrivals.forEach((arrival: any) => {
        if (arrival.vehicle_position?.lat && arrival.vehicle_position?.lon) {
          const vehicleColor = getVehicleColor(arrival.real_life_route_id);

          const vehicleMarker = new google.maps.Marker({
            map,
            position: {
              lat: arrival.vehicle_position.lat,
              lng: arrival.vehicle_position.lon
            },
            title: arrival.real_life_route_id,
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: vehicleColor,
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 2
            }
          });
          vehicleMarker.addListener("click", () => {
            vehicleInfoWindow.setContent(`
              <div style="font-size:14px;font-weight:600">
                ${arrival.real_life_route_id}
              </div>
            `);
            vehicleInfoWindow.open(map, vehicleMarker);
          });

          (vehicleMarker as any).tripId = arrival.trip_id;

          if (selectedTripId && arrival.trip_id !== selectedTripId) {
            vehicleMarker.setVisible(false);
          }

          vehicleMarkers.push(vehicleMarker);
        }
      });
      if (!selectedTripId) vehicleMarkers.forEach(marker => marker.setVisible(true));

    } catch (error) {
      console.error("Error fetching future arrivals:", error);
      futureArrivals = [];
      selectedTripId = null;
      clearVehicleMarkers();
    }
  }

  async function fetchAndShowNavigationVehicles(route: any) {
    clearVehicleMarkers();
    if (!route || !route.legs) return;

    // Reset leg info before fetching
    const newLegInfo: Record<number, { 
      primary: { minutes: number, status: string, historic_latency?: number, historic_relationship?: string },
      secondary: Array<{ minutes: number, status: string }>
    }> = {};
    vehicleInfoWindow = vehicleInfoWindow || new google.maps.InfoWindow();

    // Use map + Promise.all to handle multiple legs concurrently and track index
    const promises = route.legs.map(async (leg: any, index: number) => {
      // Skip logic for non-transit legs
      if (leg.type !== 'transit' || !leg.from_stop_id || !leg.trip_id) return;

      const targetPrefix = leg.trip_id.split('-')[0];
      
      try {
        const res = await fetch(`/api/stops/${leg.from_stop_id}/future-arrivals`);
        const arrivals = await res.json();
        
        // Filter for specific line
        const relevantArrivals: any[] = [];
        
        arrivals.forEach((arrival: any) => {
          if (!arrival.trip_id || !arrival.vehicle_position?.lat || !arrival.vehicle_position?.lon) return;
          
          const arrivalPrefix = arrival.trip_id.split('-')[0];
          
          if (arrivalPrefix === targetPrefix) {
            const vehicleColor = getVehicleColor(arrival.real_life_route_id);
            
            const marker = new google.maps.Marker({
              map,
              position: { 
                lat: arrival.vehicle_position.lat, 
                lng: arrival.vehicle_position.lon 
              },
              title: arrival.real_life_route_id,
              icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 8,
                fillColor: vehicleColor,
                fillOpacity: 1,
                strokeColor: "#ffffff",
                strokeWeight: 2
              }
            });
            
            marker.addListener("click", () => {
              vehicleInfoWindow.setContent(`
                <div style="font-size:14px;font-weight:600">
                  ${arrival.real_life_route_id}
                </div>
              `);
              vehicleInfoWindow.open(map, marker);
            });
            
            (marker as any).tripId = arrival.trip_id;
            vehicleMarkers.push(marker);

            // Collect for info display
            relevantArrivals.push(arrival);
          }
        });

        // Calculate and store real-time info for the UI
        if (relevantArrivals.length > 0) {
            // Sort to find the very next arrival
            relevantArrivals.sort((a, b) => {
                return calculateMinutesUntil(a.expected_arrival_time) - calculateMinutesUntil(b.expected_arrival_time);
            });

            // Primary
            const nextBus = relevantArrivals[0];
            const primary = {
                minutes: calculateMinutesUntil(nextBus.expected_arrival_time),
                latency: Math.floor(nextBus.delay_seconds/60),
                status: nextBus.schedule_relationship_status || 'scheduled',
                historic_latency: nextBus.historic_latency,
                historic_relationship: nextBus.historic_relationship
            };

            // Secondary (Take next 2)
            const secondary = relevantArrivals.slice(1, 3).map(bus => ({
                minutes: calculateMinutesUntil(bus.expected_arrival_time),
                status: bus.schedule_relationship_status || 'scheduled'
            }));
            
            newLegInfo[index] = { primary, secondary };
        }
        
      } catch (e) {
        console.error(`Error fetching nav vehicles for leg ${index}:`, e);
      }
    });

    await Promise.all(promises);
    legRealTimeInfo = newLegInfo; // Update state
  }

  async function fetchNavigation(destLat: number, destLon: number) {
    const origin = startPoint || userLocation;
    if (!origin) {
        alert("Waiting for location...");
        return;
    }
    try {
      const now = new Date();
      let timeStr = departureTime;
      
      if (!timeStr) {
        timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      } else {
        timeStr = `${timeStr}:00`;
      }
      
      const url = `/api/navigate?origin_lat=${origin.lat}&origin_lon=${origin.lng}&dest_lat=${destLat}&dest_lon=${destLon}&departure_time=${timeStr}`;
      
      const response = await fetch(url);
      const data = await response.json();
      navigationRoutes = data.routes || [];
      selectedRouteIndex = 0;
      showNavigation = true;
      currentNavigationDest = { lat: destLat, lon: destLon };
      await new Promise(resolve => setTimeout(resolve, 0));
      if (navigationRoutes.length > 0) {
        renderRoute(0);
      } else {
        clearNavigationPolylines();
        clearVehicleMarkers();
      }
    } catch (error) {
      console.error("Error fetching navigation:", error);
      alert("Error fetching navigation");
    }
  }

  function renderRoute(routeIndex: number) {
    clearNavigationPolylines();
    const route = navigationRoutes[routeIndex];
    if (!route) return;

    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }

    // Filter stops (fixed size)
    filterStopsForRoute(route);

    // Initial Fetch
    fetchAndShowNavigationVehicles(route);

    // Auto Refresh
    refreshInterval = setInterval(() => {
        fetchAndShowNavigationVehicles(route);
    }, 5000);

    route.legs.forEach((leg: any) => {
      if (leg.type === "walk") {
        const polyline = new google.maps.Polyline({
          path: [
            { lat: leg.from.lat, lng: leg.from.lon },
            { lat: leg.to.lat, lng: leg.to.lon }
          ],
          geodesic: true,
          strokeColor: "#9CA3AF",
          strokeOpacity: 0.8,
          strokeWeight: 3,
          map
        });
        navigationPolylines.push(polyline);
      } else if (leg.type === "transit") {
        const polyline = new google.maps.Polyline({
          path: [
            { lat: leg.from?.lat || 42.6977, lng: leg.from?.lon || 23.3219 },
            { lat: leg.to?.lat || 42.6977, lng: leg.to?.lon || 23.3219 }
          ],
          geodesic: true,
          strokeColor: getVehicleColor(leg.route_id),
          strokeOpacity: 1,
          strokeWeight: 4,
          map
        });
        navigationPolylines.push(polyline);
      }
    });
  }

  async function loadIconAsDataUrl(type: string): Promise<string> {
    if (iconCache[type]) return iconCache[type];
    const response = await fetch(`/icons/${type}.png`);
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        iconCache[type] = dataUrl;
        resolve(dataUrl);
      };
      reader.readAsDataURL(blob);
    });
  }

  function extractTransportType(stop_code: string) {
    const match = stop_code.match(/^[a-zA-Z]{1,2}/);
    const letters = match ? match[0] : null;
    switch (letters) {
      case "A": return "bus";
      case "TM": return "tram";
      case "TB": return "trolley";
      case "M": return "metro";
      default: return "trolley";
    }
  }
  
  function startWatchingLocation() {
    if (navigator.geolocation) {
      watchId = navigator.geolocation.watchPosition(
        (position) => {
          userLocation = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
          };

          if (userMarker) {
            userMarker.setPosition(userLocation);
          } else if (map) {
            userMarker = new google.maps.Marker({
              map,
              position: userLocation,
              title: "Your Location",
              icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 7,
                fillColor: "#4285F4",
                fillOpacity: 1,
                strokeColor: "#ffffff",
                strokeWeight: 2,
              },
              zIndex: 9999
            });
          }
        },
        (error) => {
          console.error("Error watching location:", error);
        },
        {
          enableHighAccuracy: true,
          timeout: 5000,
          maximumAge: 0
        }
      );
    }
  }

  function centerOnUser() {
    if (userLocation && map) {
      map.setCenter(userLocation);
      map.setZoom(15);
    } else {
      navigator.geolocation.getCurrentPosition(
        (position) => {
            const loc = { lat: position.coords.latitude, lng: position.coords.longitude };
            map.setCenter(loc);
            map.setZoom(15);
        },
        () => alert("Could not find your location.")
      );
    }
  }

  onMount(async () => {
    const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!API_KEY) return console.error("❌ Missing VITE_GOOGLE_MAPS_API_KEY");

    setOptions({ key: API_KEY, version: "weekly", libraries: ["maps", "places"] });
    const { Map } = await importLibrary("maps");
    await importLibrary("places");

    map = new Map(mapEl, {
      center: { lat: 42.6977, lng: 23.3219 },
      zoom: 13,
      mapTypeControl: false,
      zoomControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      styles: [
        { featureType: "transit", stylers: [{ visibility: "off" }] },
        { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] }
      ]
    });

    startWatchingLocation();

    const locationButton = document.createElement("button");
    locationButton.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="#666" d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>`;
    locationButton.style.cssText = `
        background: white; border: none; border-radius: 2px;
        box-shadow: rgba(0, 0, 0, 0.3) 0px 1px 4px -1px;
        cursor: pointer; width: 40px; height: 40px;
        position: absolute; top: 10px; /* Changed from bottom: 24px; */
        right: 24px; z-index: 1000;
        display: flex; align-items: center; justify-content: center;
    `;
    locationButton.onclick = centerOnUser;
    mapEl.appendChild(locationButton);
    map.addListener("tilesloaded", () => console.log("🗺️ Tiles loaded successfully"));

    map.addListener("click", () => {
      vehicleInfoWindow?.close();
    });
    const searchContainer = document.createElement("div");
    searchContainer.style.cssText = `
      position: absolute;
      top: 10px;
      left: 24px; /* Changed from left: 50%; */
      /* transform: translateX(-50%); REMOVED */
      z-index: 1000;
      width: 67%;
    `;
    
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = "Search location...";
    searchInput.style.cssText = `
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 14px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    `;
    
    searchContainer.appendChild(searchInput);
    mapEl.appendChild(searchContainer);

    const { PlacesService } = await importLibrary("places");
    const placesService = new PlacesService(map);
    
    const AutocompleteClass = await importLibrary("places");
    Autocomplete = AutocompleteClass.Autocomplete;
    const autocomplete = new Autocomplete(searchInput);
    autocomplete.bindTo("bounds", map);
    autocomplete.addListener("place_changed", () => {
      closePopup();
      const place = autocomplete.getPlace();
      
      if (!place.geometry || !place.geometry.location) {
        console.error("No geometry found for place");
        return;
      }

      const destLat = place.geometry.location.lat();
      const destLon = place.geometry.location.lng();
      
      if (!userLocation) {
        const center = map.getCenter();
        userLocation = {
            lat: center.lat(),
            lng: center.lng()
        };
      }
      
      map.setCenter(place.geometry.location);
      map.setZoom(15);
      
      fetchNavigation(destLat, destLon);
    });



    await Promise.all([
      loadIconAsDataUrl("bus"),
      loadIconAsDataUrl("tram"),
      loadIconAsDataUrl("trolley"),
      loadIconAsDataUrl("metro")
    ]);
    const res = await fetch("/api/stops");
    const stops: BusStop[] = await res.json();
    const currentZoom = map.getZoom() || 13;
    const iconSize = getIconSize(currentZoom);
    const usedCodes = new Set<string>();

    for (const stop of stops) {
      if (!stop.stop_name) continue;
      const codePattern = /^(M\d+|\d{1,4})$/;
      if (!codePattern.test(stop.stop_code)) continue;

      if (usedCodes.has(stop.stop_code)) continue;
      usedCodes.add(stop.stop_code);

      const position = { lat: Number(stop.stop_lat), lng: Number(stop.stop_lon) };
      if (!isFinite(position.lat) || !isFinite(position.lng)) continue;

      const transportType = extractTransportType(stop.stop_id);
      const iconDataUrl = iconCache[transportType];
      const marker = new google.maps.Marker({
        map,
        position,
        title: stop.stop_name,
        icon: { url: iconDataUrl, scaledSize: new google.maps.Size(iconSize, iconSize), anchor: new google.maps.Point(iconSize / 2, iconSize) }
      });
      
      (marker as any).stopId = stop.stop_id;

      marker.addListener("click", async () => {
        selectedStop = stop.stop_name;
        selectedStopCode = stop.stop_id;
        selectedMarker = marker;
        showPopup = true;

        if (!showNavigation) {
             markers.forEach(m => { if (m !== marker) m.setVisible(false); });
        }

        marker.setIcon({
          url: iconDataUrl,
          scaledSize: new google.maps.Size(16, 16),
          anchor: new google.maps.Point(8, 16)
        });

        if (refreshInterval) clearInterval(refreshInterval);

        await fetchStopArrivals(stop.stop_id);

        refreshInterval = setInterval(() => {
          if (selectedStopCode) fetchStopArrivals(selectedStopCode);
        }, 5000);
      });
      markers.push(marker);
    }

    map.addListener("zoom_changed", () => {
      // Do not resize stops if we are in navigation mode
      if (showNavigation) return;

      const zoom = map.getZoom() || 13;
      const newIconSize = getIconSize(zoom);

      markers.forEach(marker => {
        if (selectedMarker && marker === selectedMarker) return;
        const currentIcon = marker.getIcon() as google.maps.Icon;
        if (currentIcon?.url) {
          marker.setIcon({
            url: currentIcon.url,
            scaledSize: new google.maps.Size(newIconSize, newIconSize),
            anchor: new google.maps.Point(newIconSize / 2, newIconSize)
          });
        }
      });
    });
  });

  onDestroy(() => {
    if (watchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchId);
    }
  });
</script>

<div bind:this={mapEl} class="map"></div>

{#if showPopup}
  <div class="popup">
    <div class="popup-header">
      <h3>{selectedStop}</h3>
      <button class="close-btn" on:click={closePopup}>×</button>
    </div>

    <div class="popup-content">
      {#if futureArrivals.length > 0}
        <table>
          <thead>
            <tr>
              <th>Trip ID</th>
              <th>Direction</th>
              <th>Arrives in</th>
              <th>Status</th>
              <th>Usually</th>
            </tr>
          </thead>
          <tbody>
            {#each futureArrivals as arrival}
              {#if calculateMinutesUntil(arrival.expected_arrival_time) < 1300}
                  <tr 
                  on:click={() => selectTrip(arrival.trip_id)}
                  class:selected={selectedTripId === arrival.trip_id}
                  >
                  <td>{arrival.real_life_route_id}</td>
                  <td>{arrival.trip_headsign}</td>
                  {#if calculateMinutesUntil(arrival.expected_arrival_time) > 1}
                    <td>{calculateMinutesUntil(arrival.expected_arrival_time)} min</td>
                  {:else}
                    <td>Arriving soon</td>
                  {/if}
                  {#if arrival.schedule_relationship_status=="on time"}
                    <td>on time</td>
                  {:else if arrival.schedule_relationship_status=="early"}
                    <td>{Math.abs(Math.floor(arrival.delay_seconds/60))} min early</td>
                  {:else}
                    <td>{Math.floor(arrival.delay_seconds/60)} min late</td>
                  {/if}
                  {#if arrival.historic_relationship=="on time"}
                    <td>on time</td>
                  {:else if arrival.historic_relationship=="early"}
                    <td>{Math.abs(arrival.historic_latency)} min early</td>
                  {:else}
                    <td>{arrival.historic_latency} min late</td>
                  {/if}
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="no-arrivals">No upcoming arrivals</p>
      {/if}
    </div>
  </div>
{/if}

{#if showNavigation}
  <div class="navigation-panel">
    <div class="nav-header">
      <div class="nav-header-top">
        <h3>Navigation</h3>
        <button class="close-btn" on:click={closeNavigation}>×</button>
      </div>
      <div class="startpoint-section">
        <button 
          class="startpoint-btn"
          on:click={() => {
            showStartPointSelector = !showStartPointSelector;
            if (showStartPointSelector && startPointSearchInput) {
              startPointSearchInput.value = "";
              startPointAutocomplete = null;
            }
          }}
        >
          📍 Start: {startPoint ? `${startPoint.lat.toFixed(3)}, ${startPoint.lng.toFixed(3)}` : 'Current'}
        </button>
        {#if showStartPointSelector}
          <div class="startpoint-dropdown">
            <input 
              type="text"
              placeholder="Search starting point..."
              class="startpoint-search"
              bind:this={startPointSearchInput}
              on:focus={() => {
                if (startPointSearchInput) {
                  startPointAutocomplete = new Autocomplete(startPointSearchInput);
                  startPointAutocomplete.bindTo("bounds", map);
                  startPointAutocomplete.addListener("place_changed", () => {
                    const place = startPointAutocomplete.getPlace();
                    if (!place.geometry || !place.geometry.location) {
                      console.error("No geometry found for place");
                      return;
                    }
                    startPoint = {
                      lat: place.geometry.location.lat(),
                      lng: place.geometry.location.lng()
                    };
                    showStartPointSelector = false;
                    if (currentNavigationDest) {
                      fetchNavigation(currentNavigationDest.lat, currentNavigationDest.lon);
                    }
                  });
                }
              }}
            />
            <button 
              class="dropdown-item"
              on:click={() => {
                if (startPointSearchInput) {
                  startPointSearchInput.value = "";
                }
                startPoint = null;
                showStartPointSelector = false;
                if (currentNavigationDest) {
                  fetchNavigation(currentNavigationDest.lat, currentNavigationDest.lon);
                }
              }}
            >
              📍 Use Current Location
            </button>
          </div>
        {/if}
      </div>
      <div class="nav-controls">
        <input 
          type="time" 
          bind:value={departureTime}
          class="time-input"
        />
        <button 
          class="reset-time-btn"
          on:click={() => {
            departureTime = "";
            if (currentNavigationDest) {
              fetchNavigation(currentNavigationDest.lat, currentNavigationDest.lon);
            }
          }}
          title="Reset to now"
        >
          Now
        </button>
        <button 
          class="submit-time-btn"
          on:click={() => {
            if (currentNavigationDest) {
              fetchNavigation(currentNavigationDest.lat, currentNavigationDest.lon);
            }
          }}
          title="Search with this time"
        >
          Go
        </button>
      </div>
    </div>

    <div class="nav-content">
      {#if navigationRoutes.length > 0}
        <div class="route-selector">
          {#each navigationRoutes as route, idx}
            <button 
              class:active={selectedRouteIndex === idx}
              on:click={() => { selectedRouteIndex = idx; renderRoute(idx); }}
            >
              <div class="route-lines">{getTransitRouteIds(route).join(' → ')}</div>
              <div class="route-time">{route.total_time_minutes.toFixed(1)} min</div>
            </button>
          {/each}
        </div>

        <div class="route-details">
          {#each navigationRoutes[selectedRouteIndex]?.legs || [] as leg, i}
            {#if leg.type === "walk"}
              <div class="leg walk-leg">
                <div class="leg-icon">🚶</div>
                <div class="leg-info">
                  <div class="leg-type">Walk</div>
                  <div class="leg-details">
                    {leg.distance_m}m • {Math.round(leg.duration_seconds / 60)} min
                  </div>
                  {#if leg.stop_name}
                    <div class="leg-stop">to {leg.stop_name}</div>
                  {/if}
                </div>
              </div>
            {:else if leg.type === "transit"}
              <div class="leg transit-leg">
                <div class="leg-icon">🚌</div>
                <div class="leg-info">
                  <div class="leg-type">{leg.route_id}</div>
                  <div class="leg-details">
                    {leg.from_stop_name} → {leg.to_stop_name}
                  </div>
                </div>

                {#if legRealTimeInfo[i]}
                  <div class="arrival-group">
                    <div class="arrival-row">
                      <div 
                        class="live-arrival"
                        class:status-late={legRealTimeInfo[i].primary.status === 'late'}
                        class:status-early={legRealTimeInfo[i].primary.status === 'early'}
                        class:status-ontime={legRealTimeInfo[i].primary.status === 'on time'}
                      >
                        {#if legRealTimeInfo[i].primary.minutes > 1}
                          {legRealTimeInfo[i].primary.minutes} min
                        {:else}
                          Arriving soon
                        {/if}
                      </div>
                      
                      {#if legRealTimeInfo[i].primary.historic_latency !== undefined && legRealTimeInfo[i].primary.historic_relationship}
                        <div 
                          class="historic-badge"
                          class:status-late={legRealTimeInfo[i].primary.latency < legRealTimeInfo[i].primary.historic_latency}
                          class:status-early={legRealTimeInfo[i].primary.latency > legRealTimeInfo[i].primary.historic_latency}
                          class:status-ontime={legRealTimeInfo[i].primary.latency == legRealTimeInfo[i].primary.historic_latency}
                        >
                          {#if legRealTimeInfo[i].primary.latency == legRealTimeInfo[i].primary.historic_latency}
                            ✔
                          {:else if legRealTimeInfo[i].primary.latency < legRealTimeInfo[i].primary.historic_latency}
                            +{legRealTimeInfo[i].primary.historic_latency - legRealTimeInfo[i].primary.latency} min
                          {:else}
                            -{legRealTimeInfo[i].primary.latency - legRealTimeInfo[i].primary.historic_latency} min
                          {/if}
                        </div>
                      {/if}
                    </div>
                    
                    {#if legRealTimeInfo[i].secondary.length > 0}
                      <div class="secondary-row">
                        {#each legRealTimeInfo[i].secondary as next}
                          <div 
                            class="secondary-arrival"
                            class:status-late={next.status === 'late'}
                            class:status-early={next.status === 'early'}
                            class:status-ontime={next.status === 'on time'}
                          >
                            {next.minutes} min
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {:else}
        <div class="no-routes-message">
          <p>No routes found for this journey</p>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .map { position: fixed; inset: 0; }
  :global(button[aria-label="Map camera controls"]) { display: none !important; }
  :global(.gm-control-active[aria-label="Map camera controls"]) { display: none !important; }
  
  .popup { 
    position: fixed; 
    bottom: 0; 
    left: 0; 
    right: 0; 
    background: white; 
    border-top-left-radius: 16px; 
    border-top-right-radius: 16px; 
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15); 
    max-height: 50vh; 
    overflow: hidden; 
    display: flex; 
    flex-direction: column; 
    z-index: 1000; 
  }
  .popup-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #e5e7eb; }
  .popup-header h3 { margin: 0; font-size: 18px; font-weight: 600; }
  .popup-content { overflow-y: auto; padding: 16px 20px; }
  table { width: 100%; border-collapse: collapse; }
  thead { background: #f9fafb; }
  th { text-align: left; padding: 12px; font-weight: 600; font-size: 14px; color: #374151; }
  td { padding: 12px; border-top: 1px solid #e5e7eb; }
  tbody tr:hover { background: #f9fafb; }
  tbody tr { cursor: pointer; }
  tbody tr.selected { background: #dbeafe; }
  tbody tr.selected:hover { background: #bfdbfe; }
  .no-arrivals { text-align: center; color: #6b7280; padding: 20px; margin: 0; }
  :global(.gm-style-iw .gm-ui-hover-effect) { display: none !important; }

  .navigation-panel { 
    position: fixed; 
    bottom: 0; 
    left: 0; 
    right: 0; 
    background: white; 
    border-top-left-radius: 16px; 
    border-top-right-radius: 16px; 
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15); 
    max-height: 50vh; 
    overflow: hidden; 
    display: flex; 
    flex-direction: column; 
    z-index: 1000; 
  }
  .nav-header { display: flex; flex-direction: column; gap: 12px; padding: 16px 20px; border-bottom: 1px solid #e5e7eb; }
  .nav-header h3 { margin: 0; font-size: 18px; font-weight: 600; }
  .nav-header-top { display: flex; justify-content: space-between; align-items: center; }
  .nav-controls { display: flex; gap: 8px; align-items: center; }
  .startpoint-section { position: relative; }
  .startpoint-btn { 
    padding: 6px 10px; 
    border: 1px solid #d1d5db; 
    border-radius: 4px; 
    background: white; 
    cursor: pointer; 
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    transition: all 0.2s;
  }
  .startpoint-btn:hover { background: #f3f4f6; border-color: #9ca3af; }
  .startpoint-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 4px;
    background: white;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    z-index: 10;
    min-width: 90%;
    width: 100%;
    overflow: hidden;
  }
  .startpoint-search {
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-bottom: 1px solid #d1d5db;
    font-size: 12px;
    box-sizing: border-box;
  }
  .startpoint-search:focus {
    outline: none;
    background: #f9fafb;
  }
  .dropdown-item {
    display: block;
    width: 100%;
    padding: 8px 12px;
    border: none;
    background: white;
    cursor: pointer;
    font-size: 12px;
    text-align: left;
    transition: background 0.2s;
  }
  .dropdown-item:hover { background: #f3f4f6; }
  .time-input { 
    padding: 4px 8px; 
    border: 1px solid #d1d5db; 
    border-radius: 4px; 
    font-size: 12px;
    width: 95px;
  }
  .reset-time-btn, .submit-time-btn { 
    padding: 6px 12px; 
    border: 1px solid #d1d5db; 
    border-radius: 4px; 
    background: white; 
    cursor: pointer; 
    font-size: 13px;
    font-weight: 500;
    transition: all 0.2s;
  }
  .reset-time-btn:hover { background: #f3f4f6; border-color: #9ca3af; }
  .submit-time-btn { background: #3b82f6; color: white; border-color: #3b82f6; }
  .submit-time-btn:hover { background: #2563eb; border-color: #2563eb; }
  .nav-content { overflow-y: auto; padding: 16px 20px; flex: 1; }

  .route-selector { display: flex; gap: 8px; margin-bottom: 20px; }
  .route-selector button { flex: 1; padding: 12px; border: 2px solid #e5e7eb; border-radius: 8px; background: white; cursor: pointer; transition: all 0.2s; }
  .route-selector button:hover { border-color: #bfdbfe; }
  .route-selector button.active { border-color: #3b82f6; background: #eff6ff; }
  .route-lines { font-weight: 600; font-size: 14px; color: #1f2937; }
  .route-time { font-size: 12px; color: #6b7280; }

  .route-details { display: flex; flex-direction: column; gap: 12px; }
  .no-routes-message { padding: 32px 20px; text-align: center; color: #6b7280; }
  .no-routes-message p { margin: 0; font-size: 14px; }
  .leg { display: flex; gap: 12px; padding: 12px; border-radius: 8px; background: #f9fafb; }
  .walk-leg { background: #f3f4f6; }
  .transit-leg { background: #eff6ff; }
  .leg-icon { font-size: 20px; }
  .leg-info { flex: 1; min-width: 0; }
  .leg-type { font-weight: 600; font-size: 14px; color: #1f2937; }
  .leg-details { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .leg-stop { font-size: 12px; color: #374151; margin-top: 4px; }

  .arrival-group {
    display: flex;
    flex-direction: column;
    align-items: flex-end; 
    margin-left: auto;
    gap: 4px;
  }

  .arrival-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .live-arrival {
    font-weight: 700;
    font-size: 14px;
    padding: 4px 8px;
    border-radius: 4px;
    background: #f3f4f6;
    color: #374151;
    white-space: nowrap;
  }

  .historic-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 5px;
    border-radius: 3px;
    background: #f3f4f6;
    color: #6b7280;
    white-space: nowrap;
  }

  .secondary-row {
    display: flex;
    gap: 4px;
  }

  .secondary-arrival {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 3px;
    background: #f3f4f6;
    color: #6b7280;
    white-space: nowrap;
  }

  .status-late {
    color: #DC2626;
    background: #FEF2F2;
  }

  .status-early {
    color: #CA8A04;
    background: #FEFCE8;
  }

  .status-ontime {
    color: #16A34A;
    background: #F0FDF4;
  }

  .close-btn { background: none; border: none; font-size: 28px; cursor: pointer; color: #6b7280; padding: 0; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; }
  .close-btn:hover { color: #1f2937; }
</style>