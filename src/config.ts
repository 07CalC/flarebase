
export type Bindings = {

} & CloudflareBindings;


export type Variables = {
  auth: {
    id: string;
    isSuperUser: boolean;
    collectionId: string;
    sessionId: string;
  } | null;
}

export type HonoApp = {
  Bindings: Bindings;
  Variables: Variables;
}


