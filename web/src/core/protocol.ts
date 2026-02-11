export type ControlMsg =
  | {
      t: "file_offer";
      fileId: string;
      name: string;
      size: number;
      total: number;
    }
  | { t: "file_accept"; fileId: string; have: number[] }
  | { t: "ack"; fileId: string; received: number[] }
  | { t: "ping" }
  | { t: "resume"; fileId: string };

export type DataChunk = {
  fileId: string;
  index: number;
  payload: string; // encrypted base64
};
