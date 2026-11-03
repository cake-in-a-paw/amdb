/** The signed-in caller's session: who and when it was created. */
export interface SessionInfo {
  userId: string;
  createdAt: Date;
}

export interface AppEnv {
  Variables: { userId: string; session: SessionInfo };
}
