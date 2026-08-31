import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from "sonner";
import axios from 'axios';
import { API_BASE_URL } from '@/lib/api';
import { Loader2 } from 'lucide-react';
import { useEventTracker } from '@/hooks/useEventTracker';

interface OpenAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  onSuccess: () => void;
}

const OpenAccountModal = ({ isOpen, onClose, userId, onSuccess }: OpenAccountModalProps) => {
  const { measureAndTrack } = useEventTracker();
  const [accountType, setAccountType] = useState('SAVINGS');
  const [ifsc, setIfsc] = useState('NEXA0001');
  const [initialDeposit, setInitialDeposit] = useState('1000');
  const [isLoading, setIsLoading] = useState(false);

  const handleCreateAccount = async () => {
    if (!accountType || !ifsc) {
      toast.error('Please fill all required fields');
      return;
    }
    
    setIsLoading(true);
    try {
      await measureAndTrack('accounts.open_account', async () => {
        await axios.post(
          `${API_BASE_URL}/accounts`,
          {
            customerId: userId,
            ifsc: ifsc,
            accountType: accountType,
            balance: parseFloat(initialDeposit) || 0
          },
          { withCredentials: true }
        );
      });
      
      toast.success('Account created successfully 🎉');
      onSuccess();
      onClose();
      // Reset form
      setAccountType('SAVINGS');
      setInitialDeposit('1000');
    } catch (error: any) {
      console.error("Account creation error:", error);
      toast.error(error.response?.data?.error || "Failed to create account. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open New Account</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Account Type</label>
            <Select value={accountType} onValueChange={setAccountType}>
              <SelectTrigger className="rounded-lg">
                <SelectValue placeholder="Select account type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SAVINGS">Savings Account</SelectItem>
                <SelectItem value="CURRENT">Current Account</SelectItem>
                <SelectItem value="INVESTMENT">Investment Account</SelectItem>
                <SelectItem value="CREDIT_CARD">Credit Card</SelectItem>
              </SelectContent>
            </Select>
          </div>
          
          <div className="space-y-2">
            <label className="text-sm font-medium">Branch IFSC Code</label>
            <Input
              value={ifsc}
              onChange={(e) => setIfsc(e.target.value.toUpperCase())}
              placeholder="e.g. NEXA0001 / SAFX0001"
              className="rounded-lg font-mono uppercase"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Initial Deposit (₹)</label>
            <Input
              type="number"
              min="0"
              placeholder="Enter amount"
              value={initialDeposit}
              onChange={(e) => setInitialDeposit(e.target.value)}
              className="rounded-lg"
            />
          </div>
        </div>
        <DialogFooter className="flex gap-2 sm:justify-end flex-col sm:flex-row">
          <Button variant="outline" onClick={onClose} disabled={isLoading} className="rounded-lg w-full sm:w-auto">
            Cancel
          </Button>
          <Button onClick={handleCreateAccount} disabled={isLoading} className="bg-violet-600 hover:bg-violet-700 rounded-lg shadow-md w-full sm:w-auto">
            {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : "Open Account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default OpenAccountModal;
