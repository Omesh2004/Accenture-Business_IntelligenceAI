"use client";

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from "sonner";
import { Loader2, SendHorizontal, IndianRupee } from 'lucide-react';
import axios from 'axios';
import { API_BASE_URL } from '@/lib/api';
import { UserData } from '../context/UserContext';
import { useEventTracker } from '@/hooks/useEventTracker';

interface RawAccount {
  accNo: string;
  accountType: string;
  balance: number;
  ifsc: string;
}

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  accounts: RawAccount[];
  payeeAccNo: string;
  payeeName?: string;
  onSuccess?: () => void;
}

const PaymentModal = ({ isOpen, onClose, accounts, payeeAccNo, payeeName, onSuccess }: PaymentModalProps) => {
  const { globalAccounts, fetchGlobalAccounts } = UserData();
  const { measureAndTrack } = useEventTracker();
  const [fromAccount, setFromAccount] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);

  const handleClose = () => {
    setFromAccount('');
    setAmount('');
    setDescription('');
    onClose();
  };

  const selectedFrom = accounts.find(a => a.accNo === fromAccount);
  const parsedAmount = parseFloat(amount);

  const handlePayment = async () => {
    if (!fromAccount) {
      toast.error('Please select a source account');
      return;
    }
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }
    if (selectedFrom && selectedFrom.balance < parsedAmount) {
      toast.error('Insufficient funds');
      return;
    }

    setLoading(true);
    try {
      await measureAndTrack('payees.pay_now', async () => {
        await axios.post(
          `${API_BASE_URL}/accounts/pay`,
          {
            fromAccountNo: fromAccount,
            toAccountNo: payeeAccNo,
            amount: parsedAmount,
            description: description || `Payment to ${payeeName || payeeAccNo}`,
          },
          { withCredentials: true }
        );
      });

      toast.success(`Payment of ₹${parsedAmount.toLocaleString('en-IN')} was successful.`);
      onSuccess?.();
      handleClose();

      if (globalAccounts && fetchGlobalAccounts) {
        await fetchGlobalAccounts();
      }
    } catch (error: any) {
      console.error('Payment error:', error);
      toast.error('Payment failed. Please verify your details or try again later.');
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
              <SendHorizontal className="h-5 w-5 text-violet-600" />
            </div>
            <DialogTitle className="text-xl font-bold text-zinc-900">Pay Now</DialogTitle>
          </div>
          {payeeName && (
            <p className="text-sm text-muted-foreground">
              Sending money to <span className="font-semibold text-zinc-700">{payeeName}</span>
            </p>
          )}
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Payee Account (read-only) */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-zinc-700">To Account</label>
            <div className="h-12 flex items-center px-3 rounded-xl bg-gray-100 border border-gray-200">
              <span className="text-sm font-mono text-zinc-700">{payeeAccNo}</span>
              {payeeName && (
                <span className="ml-auto text-xs text-muted-foreground">{payeeName}</span>
              )}
            </div>
          </div>

          {/* Source Account */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-zinc-700">From Account</label>
            <Select value={fromAccount} onValueChange={setFromAccount}>
              <SelectTrigger className="w-full h-12 rounded-xl border-gray-200 focus:border-violet-400">
                <SelectValue placeholder="Select your account" />
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
            <label className="text-sm font-semibold text-zinc-700">Note <span className="text-muted-foreground font-normal">(optional)</span></label>
            <Input
              placeholder="What's this payment for?"
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
            onClick={handlePayment}
            disabled={loading || !fromAccount || !amount}
            className="rounded-xl bg-violet-600 hover:bg-violet-700 text-white min-w-[120px]"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Processing...
              </>
            ) : (
              <>
                <SendHorizontal className="h-4 w-4 mr-2" />
                Pay Now
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PaymentModal;
