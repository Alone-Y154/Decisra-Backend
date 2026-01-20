type DailyRoom = {
  name: string;
  url: string;
};

type CreateRoomInput = {
  apiKey: string;
  roomName: string;
  exp: number; // unix seconds
};

type CreateMeetingTokenInput = {
  apiKey: string;
  roomName: string;
  exp: number; // unix seconds
  isOwner: boolean;
  startAudioOff?: boolean;
  startVideoOff?: boolean;
};

const DAILY_API_BASE = "https://api.daily.co/v1";

async function dailyFetch(path: string, input: { apiKey: string; method: string; body?: unknown }) {
  const res = await fetch(`${DAILY_API_BASE}${path}`, {
    method: input.method,
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: input.body ? JSON.stringify(input.body) : undefined
  });

  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;

  if (!res.ok) {
    const message =
      json && typeof json === "object" && !Array.isArray(json) && "info" in (json as any)
        ? String((json as any).info)
        : `Daily API error (${res.status})`;
    const err = new Error(message);
    (err as any).status = res.status;
    (err as any).body = json;
    throw err;
  }

  return json;
}

export async function ensureDailyRoom(input: CreateRoomInput): Promise<DailyRoom> {
  // Try create; if it already exists, fetch it.
  try {
    const created = (await dailyFetch("/rooms", {
      apiKey: input.apiKey,
      method: "POST",
      body: {
        name: input.roomName,
        properties: {
          exp: input.exp
        }
      }
    })) as any;

    return { name: created.name, url: created.url };
  } catch (err: any) {
    if (err && err.status === 409) {
      const existing = (await dailyFetch(`/rooms/${encodeURIComponent(input.roomName)}`, {
        apiKey: input.apiKey,
        method: "GET"
      })) as any;

      return { name: existing.name, url: existing.url };
    }

    throw err;
  }
}

export async function createDailyMeetingToken(input: CreateMeetingTokenInput): Promise<string> {
  const token = (await dailyFetch("/meeting-tokens", {
    apiKey: input.apiKey,
    method: "POST",
    body: {
      properties: {
        room_name: input.roomName,
        exp: input.exp,
        is_owner: input.isOwner,
        start_audio_off: input.startAudioOff ?? false,
        start_video_off: input.startVideoOff ?? false
      }
    }
  })) as any;

  if (!token || typeof token !== "object" || Array.isArray(token) || typeof (token as any).token !== "string") {
    throw new Error("Daily API: unexpected token response");
  }

  return (token as any).token;
}

export async function deleteDailyRoom(input: { apiKey: string; roomName: string }): Promise<void> {
  await dailyFetch(`/rooms/${encodeURIComponent(input.roomName)}`, {
    apiKey: input.apiKey,
    method: "DELETE"
  });
}
