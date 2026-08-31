import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { API_BASE_URL, setBrowserContext } from '@/lib/api';

export const useGeoLocation = (userId: string | undefined, isAuth: boolean = false) => {
  const [captured, setCaptured] = useState(false);
  // `captured` is state, so it updates a render too late to stop a second POST: the 10s
  // timeout and the geolocation success callback can both fire, and StrictMode mounts the
  // effect twice. Each extra POST is a second location_captured event with its own
  // event_id, which uniqExact cannot collapse. A ref settles synchronously.
  const postedRef = useRef(false);

  useEffect(() => {
    if (!userId || !isAuth || captured) return;

    const postOnce = async (body: Record<string, unknown>) => {
      if (postedRef.current) return;
      postedRef.current = true;
      await axios.post(`${API_BASE_URL}/events/location`, body, { withCredentials: true })
        .catch(console.error);
    };

    if ('geolocation' in navigator) {
      const geoTimeout = setTimeout(() => {
        if (!captured) {
          console.warn("Geolocation request timed out");
          captureFallback();
        }
      }, 10000); // 10 second timeout

      const captureFallback = async () => {
        const userAgent = navigator.userAgent || "";
        const platform = navigator.platform || (navigator as any).userAgentData?.platform || "";
        const deviceType = /Mobi|Android/i.test(userAgent) ? "mobile" : /Tablet|iPad/i.test(userAgent) ? "tablet" : "desktop";
        
        setBrowserContext({ device_type: deviceType });
        await postOnce({ deviceType, platform, userAgent });
        if (!captured) setCaptured(true);
      };

      navigator.geolocation.getCurrentPosition(
        async (position) => {
          clearTimeout(geoTimeout);
          try {
            let city = null;
            let country = null;
            
            const userAgent = navigator.userAgent || "";
            const platform = navigator.platform || (navigator as any).userAgentData?.platform || "";
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
            const isTablet = /(ipad|tablet|(android(?!.*mobile))|(windows(?!.*phone)(.*touch))|kindle|playbook|silk|(puffin(?!.*(IP|AP|WP))))/i.test(userAgent);
            const deviceType = isTablet ? "tablet" : isMobile ? "mobile" : "desktop";

            // Try precise geocoding first
            try {
              const nominatimRes = await axios.get(
                `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${position.coords.latitude}&lon=${position.coords.longitude}`,
                { timeout: 5000 }
              );
              city = nominatimRes.data?.address?.city || nominatimRes.data?.address?.town || nominatimRes.data?.address?.village || null;
              country = nominatimRes.data?.address?.country || null;
            } catch (err) {
              try {
                const geoResponse = await axios.get("https://ipapi.co/json/", { timeout: 3000 });
                city = geoResponse.data.city;
                country = geoResponse.data.country_name;
              } catch (fallbackErr) {}
            }

            // Cache the resolved values so the direct-to-ingestion tracker can carry
            // real geo instead of emitting unlocalizable rows.
            setBrowserContext({
              location: country || undefined,
              city: city || undefined,
              device_type: deviceType,
            });

            await postOnce({
               latitude: position.coords.latitude,
               longitude: position.coords.longitude,
               city,
               country,
               deviceType,
               platform,
               userAgent
            });
            setCaptured(true);
          } catch (e) {
            console.error("Location tracking failed", e);
            captureFallback();
          }
        },
        async (error) => {
          clearTimeout(geoTimeout);
          captureFallback();
        },
        { timeout: 8000 }
      );
    } else {
      const _nav = navigator as any;
      const userAgent = _nav?.userAgent || "";
      const platform = _nav?.platform || "";
      const deviceType = "desktop";
      setBrowserContext({ device_type: deviceType });
      void postOnce({ deviceType, platform, userAgent });
      setCaptured(true);
    }
  }, [userId, captured]);
};
