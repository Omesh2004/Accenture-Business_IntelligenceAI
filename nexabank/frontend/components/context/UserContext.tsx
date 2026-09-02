"use client";
import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
} from "react";
import axios from "axios";
import { API_BASE_URL } from "@/lib/api";
import { nexaTracker } from "@/lib/tracker";

interface Payee {
  name: string;
  payeeifsc: string;
  payeeAccNo: string;
  payeeType: string;
}

interface AddPayeeResponse {
  id: string;
  name: string;
  payeeAccNo: string;
  payeeType: string;
  payeeifsc: string;
}

interface EditPayeeResponse {
  // Define the structure of the response from the edit payee API
  id: string;
  name: string;
  payeeAccNo: string;
  payeeType: string;
  payeeifsc: string;
}

interface DeletePayeeResponse {
  // Define the structure of the response from the delete payee API
}

interface CheckPayeeResponse {
  name: string;
}

interface UserContextType {
  BtnLoading: boolean;
  fetchPayees: (payerCustomerId: string) => Promise<void>;
  AddPayeeById: (
    payerCustomerId: string,
    name: string,
    payeeifsc: string,
    payeeAccNo: string,
    payeeType: string
  ) => Promise<void>;
  EditPayee: (
    payerCustomerId: string,
    name: string,
    payeeifsc: string,
    payeeAccNo: string,
    payeeType: string
  ) => Promise<void>;
  DeletePayee: (payerCustomerId: string, payeeAccNo: string) => Promise<void>;
  CheckPayeeName: (payeeifsc: string, payeeAccNo: string) => Promise<void>;
  addPayee: AddPayeeResponse[];
  payees: Payee[];
  PayeeName: string;
  setUserId: (userId: string) => void;
  userId: string;
  SetUserByManual: (userId: string) => Promise<void>;
  Auth: () => Promise<string>;
  isAuth: boolean;
  isAuthLoading: boolean;
  role: string | undefined;
  tenantId: string | undefined;
  pan: string | undefined;
  globalAccounts: any[];
  fetchGlobalAccounts: (currentUserId?: string) => Promise<void>;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

interface UserContextProviderProps {
  children: ReactNode;
}

export const UserContextProvider = ({ children }: UserContextProviderProps) => {
  const [BtnLoading, setBtnLoading] = useState(false);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [addPayee, setAddPayee] = useState<AddPayeeResponse[]>([]);
  const [PayeeName, setPayeeName] = useState("");
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<string | undefined>(undefined);
  const [tenantId, setTenantId] = useState<string | undefined>(undefined);
  const [pan, setPan] = useState<string | undefined>(undefined);
  const [isAuth, setIsAuth] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  // New Global Account state to prevent harsh page reloads
  const [globalAccounts, setGlobalAccounts] = useState<any[]>([]);

  const fetchGlobalAccounts = async (currentUserId: string = userId) => {
    if (!currentUserId) return;
    try {
      const response = await axios.get(`${API_BASE_URL}/customers/accounts/${currentUserId}`, {
        withCredentials: true
      });
      setGlobalAccounts(response.data || []);
    } catch (error) {
      console.error("Error fetching global accounts:", error);
    }
  };

  const fetchPayees = async (payerCustomerId: string) => {
    setBtnLoading(true);
    try {
      const response = await axios.get(
        `${API_BASE_URL}/payees/${payerCustomerId}`,
        { withCredentials: true }
      );
      setPayees(response.data);
    } catch (error) {
      console.error("Error fetching payees:", error);
    } finally {
      setBtnLoading(false);
    }
  };

  const AddPayeeById = async (
    payerCustomerId: string,
    name: string,
    payeeifsc: string,
    payeeAccNo: string,
    payeeType: string
  ) => {
    setBtnLoading(true);
    try {
      const response = await axios.post(
        `${API_BASE_URL}/payee/${payerCustomerId}`,
        {
          name,
          payeeifsc,
          payeeAccNo,
          payeeType,
        },
        { withCredentials: true }
      );
      setAddPayee(response.data);
    } catch (error) {
      console.error("Error adding payee:", error);
      throw error; // Propagate error upstream for precise UI handling
    } finally {
      setBtnLoading(false);
    }
  };

  const EditPayee = async (
    payerCustomerId: string,
    name: string,
    payeeifsc: string,
    payeeAccNo: string,
    payeeType: string
  ) => {
    setBtnLoading(true);
    try {
      const response = await axios.put(
        `${API_BASE_URL}/payee/${payerCustomerId}`,
        {
          name,
          payeeifsc,
          payeeAccNo,
          payeeType,
        },
        { withCredentials: true }
      );
      setAddPayee(response.data);
    } catch (error) {
      console.error("Error editing payee:", error);
    } finally {
      setBtnLoading(false);
    }
  };

  const DeletePayee = async (payerCustomerId: string, payeeAccNo: string) => {
    setBtnLoading(true);
    try {
      const response = await axios.delete(
        `${API_BASE_URL}/payee/${payerCustomerId}`,
        {
          data: { payeeAccNo },
          withCredentials: true,
        }
      );
    } catch (error) {
      console.error("Error deleting payee:", error);
    } finally {
      setBtnLoading(false);
    }
  };

  const CheckPayeeName = async (payeeAccNo: string, payeeifsc: string) => {
    setBtnLoading(true);

    try {
      const response = await axios.post(
        `${API_BASE_URL}/payees/name`,
        {
          data: {
            payeeifsc,
            payeeAccNo,
          },
        },
        { withCredentials: true }
      );

      if (!response.data?.customerName) {
        throw new Error("Customer name not found in response");
      }

      setPayeeName(response.data.customerName);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          console.error("Server responded with error:", error.response.data);
        } else if (error.request) {
          console.error("No response received from server");
        } else {
          console.error("Error sending request:", error.message);
        }
      } else {
        console.error("Unexpected error:", error);
      }
    } finally {
      setBtnLoading(false);
    }
  };

  const SetUserByManual = async (userId: string) => {
    setUserId(userId);
  };

  const Auth = async (): Promise<string> => {
    setIsAuthLoading(true);
    try {
      const response = await axios.get(
        `${API_BASE_URL}/auth/cookieReturn`,
        {
          withCredentials: true,
        }
      );
      const nextUserId = response.data?.id ?? "";
      const nextRole = response.data?.role;
      setUserId(nextUserId);
      setRole(nextRole);
      setTenantId(response.data?.tenantId);
      setPan(response.data?.pan);
      setIsAuth(Boolean(nextUserId));

      // Register user with the Pathway analytics tracker.
      // No page-view is emitted here on purpose: every page already tracks its own
      // `<page>.page.view` through useEventTracker, which routes via the backend and so
      // carries session-invariant geo/device. This call emitted a second, redundant event
      // named 'page_view' -- it canonicalized to core.page.view.action (rendered nowhere)
      // and carried no location/continent, so it was an unlocalizable duplicate.
      if (nextUserId) {
        nexaTracker.setUser(nextUserId, nextRole || 'user', undefined, response.data?.tenantId);
      }

      // Auto-fetch accounts right after auth succeeds — cookie is guaranteed valid here
      if (nextUserId) {
        try {
          const accRes = await axios.get(`${API_BASE_URL}/customers/accounts/${nextUserId}`, {
            withCredentials: true,
          });
          setGlobalAccounts(accRes.data || []);
        } catch (accErr) {
          console.error("Auto-fetch accounts after auth failed:", accErr);
        }
      }

      return nextUserId;
    } catch (error) {
      setUserId("");
      setRole(undefined);
      setTenantId(undefined);
      setPan(undefined);
      setIsAuth(false);
      return "";
    } finally {
      setIsAuthLoading(false);
    }
  };

  useEffect(() => {
    Auth();
  }, []);

  return (
    <UserContext.Provider
      value={{
        Auth,
        BtnLoading,
        fetchPayees,
        AddPayeeById,
        EditPayee,
        DeletePayee,
        CheckPayeeName,
        addPayee,
        payees,
        PayeeName,
        userId,
        SetUserByManual,
        setUserId,
        isAuth,
        isAuthLoading,
        role,
        tenantId,
        pan,
        globalAccounts,
        fetchGlobalAccounts,
      }}
    >
      {children}
    </UserContext.Provider>
  );
};

export const UserData = () => {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error("UserData must be used within a UserContextProvider");
  }
  return context;
};
