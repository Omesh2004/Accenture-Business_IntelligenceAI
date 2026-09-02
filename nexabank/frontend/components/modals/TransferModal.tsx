"use client";

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from "sonner";
import { Loader2, ArrowRightLeft, IndianRupee } from 'lucide-react';
import axios from 'axios';
import { API_BASE_URL } from '@/lib/api';
import { UserData } from '../context/UserContext';
import { useEventTracker } from '@/hooks/useEventTracker';

interface RawAccount {
  accNo: string;
  accountType: string;
  balance: number;
  ifsc: string;
  customerId?: string;
}

interface TransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: RawAccount[];
  onSuccess?: () => void;
}

const TransferModal = ({ isOpen, onClose, accounts, onSuccess }: TransferModalProps) => {
  const { globalAccounts, fetchGlobalAccounts } = UserData();
  const { measureAndTrack } = useEventTracker();
  const [fromAccount, setFromAccount] = useState('');
  const [toAccount, setToAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);

  const handleClose = () => {
    setFromAccount('');
    setToAccount('');
    setAmount('');
    setDescription('');
    onClose();
  };

  const selectedFrom = accounts.find(a => a.accNo === fromAccount);
  const parsedAmount = parseFloat(amount);

  const handleTransfer = async () => {
    if (!fromAccount || !toAccount) {
      toast.error('Please select both accounts');
      return;
    }
    if (fromAccount === toAccount) {
      toast.error('Source and destination accounts cannot be the same');
      return;
    }
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }
    if (selectedFrom && selectedFrom.balance < parsedAmount) {
      toast.error('Insufficient funds in selected account');
      return;
    }

    setLoading(true);
    try {
      await measureAndTrack('accounts.transfer_money', async () => {
        await axios.post(
          `${API_BASE_URL}/accounts/transfer`,
          {
            fromAccountNo: fromAccount,
            toAccountNo: toAccount,
            amount: parsedAmount,
            description: description || 'Self Transfer',
          },
          { withCredentials: true }
        );
      });

      toast.success(`Transfer of ₹${parsedAmount.toLocaleString('en-IN')} was successful.`);
      onSuccess?.();
      handleClose();

      // Update global context directly without harsh browser reload
      if (globalAccounts && fetchGlobalAccounts) {
        await fetchGlobalAccounts();
      }
    } catch (error: any) {
      console.error('Transfer error:', error);
      toast.error(error?.response?.data?.error || 'Transfer failed. Please check your balance or try again later.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto w-[95vw] rounded-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <div className="h-9 w-9 rounded-xl bg-violet-100 flex items-center justify-center">
              <ArrowRightLeft className="h-5 w-5 text-violet-600" />
            </div>
            <DialogTitle className="text-xl font-bold text-zinc-900">Transfer Money</DialogTitle>
          </div>
          <p className="text-sm text-muted-foreground">Move funds between your own accounts instantly.</p>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* From Account */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-zinc-700">From Account</label>
            <Select value={fromAccount} onValueChange={setFromAccount}>
              <SelectTrigger className="w-full h-12 rounded-xl border-gray-200 focus:border-violet-400 focus:ring-violet-400">
                <SelectValue placeholder="Select source account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.accNo} value={account.accNo}>
                    <div className="flex flex-col">
                      <span className="font-medium">{account.accountType}</span>
                      <span className="text-xs text-muted-foreground font-mono">
                        ···· {account.accNo.slice(-4)} · ₹{account.balance.toLocaleString('en-IN')}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedFrom && (
              <p className="text-xs text-emerald-600 font-medium ml-1 flex items-center gap-1">
                <IndianRupee className="h-3 w-3" />
                Available: ₹{selectedFrom.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </p>
            )}
          </div>

          {/* To Account */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-zinc-700">To Account</label>
            <Select value={toAccount} onValueChange={setToAccount}>
              <SelectTrigger className="w-full h-12 rounded-xl border-gray-200 focus:border-violet-400 focus:ring-violet-400">
                <SelectValue placeholder="Select destination account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem
                    key={account.accNo}
                    value={account.accNo}
                    disabled={account.accNo === fromAccount}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">{account.accountType}</span>
                      <span className="text-xs text-muted-foreground font-mono">···· {account.accNo.slice(-4)}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Amount */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-zinc-700">Amount (₹)</label>
            <div className="relative">
              <IndianRupee className="absolute left-3 top-3.5 h-4 w-4 text-violet-400" />
              <Input
                type="number"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="pl-9 h-12 rounded-xl border-gray-200 focus:border-violet-400 text-lg font-semibold"
                min="1"
              />
            </div>
            {selectedFrom && parsedAmount > 0 && parsedAmount > selectedFrom.balance && (
              <p className="text-xs text-rose-500 font-medium ml-1"> Amount exceeds available balance</p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-zinc-700">Description <span className="text-muted-foreground font-normal">(optional)</span></label>
            <Input
              placeholder="e.g. Monthly savings sweep"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-12 rounded-xl border-gray-200 focus:border-violet-400"
            />
          </div>
        </div>

        <DialogFooter className="gap-3 sm:gap-0">
          <Button variant="outline" onClick={handleClose} disabled={loading} className="rounded-xl">
            Cancel
          </Button>
          <Button
            onClick={handleTransfer}
            disabled={loading || !fromAccount || !toAccount || !amount}
            className="rounded-xl bg-violet-600 hover:bg-violet-700 text-white min-w-[130px]"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Processing...
              </>
            ) : (
              <>
                <ArrowRightLeft className="h-4 w-4 mr-2" />
                Transfer
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default TransferModal;
