declare global {
  namespace Express {
    interface Request {
      id?: string;
      user?: {
        id: string;
        role: 'coach' | 'coached_student' | 'self_train_student';
      };
    }
  }
}

export {};
