
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import type { Account } from '@/types/bankTypes';

interface InvestmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: InvestmentFormData) => void;
  accounts: Account[];
}

interface InvestmentFormData {
  accountId: string;
  investmentType: string;
  symbol: string;
  amount: number;
}

const InvestmentModal = ({ isOpen, onClose, onSubmit, accounts }: InvestmentModalProps) => {
  const [formData, setFormData] = useState<InvestmentFormData>({
    accountId: accounts[0]?.id || '',
    investmentType: 'stock',
    symbol: '',
    amount: 0,
  });

  const handleChange = (field: keyof InvestmentFormData, value: string | number) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.accountId || !formData.investmentType || !formData.symbol || formData.amount <= 0) {
      toast.error('Please fill in all fields with valid values');
      return;
    }

    onSubmit(formData);

    // Reset form
    setFormData({
      accountId: accounts[0]?.id || '',
      investmentType: 'stock',
      symbol: '',
      amount: 0,
    });
  };

  const getInvestmentTypeOptions = () => {
    const types = [
      { value: 'stock', label: 'Stock' },
      { value: 'mutual_fund', label: 'Mutual Fund' },
      { value: 'etf', label: 'ETF' },
      { value: 'bond', label: 'Bond' },
    ];

    return types.map(type => (
      <SelectItem key={type.value} value={type.value}>{type.label}</SelectItem>
    ));
  };

  const getSymbolPlaceholder = () => {
    switch (formData.investmentType) {
      case 'stock':
        return 'e.g., AAPL, MSFT';
      case 'mutual_fund':
        return 'e.g., VFINX';
      case 'etf':
        return 'e.g., SPY, QQQ';
      case 'bond':
        return 'e.g., Treasury Bond';
      default:
        return 'Enter symbol';
    }
  };

  // Mock data for quick selections based on investment type
  const getQuickSelections = () => {
    const selections: Record<string, string[]> = {
      'stock': ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META'],
      'mutual_fund': ['VFINX', 'FXAIX', 'VTSAX', 'SWPPX'],
      'etf': ['SPY', 'QQQ', 'VTI', 'VOO', 'IVV'],
      'bond': ['Treasury', 'Corporate', 'Municipal']
    };

    return selections[formData.investmentType] || [];
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Make a New Investment</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">From Account</label>
            <Select 
              value={formData.accountId} 
              onValueChange={(value) => handleChange('accountId', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name} ({account.balance.toLocaleString('en-US', {
                      style: 'currency',
                      currency: account.currency
                    })})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Investment Type</label>
            <Select 
              value={formData.investmentType} 
              onValueChange={(value) => handleChange('investmentType', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select investment type" />
              </SelectTrigger>
              <SelectContent>
                {getInvestmentTypeOptions()}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Symbol/Name</label>
            <Input
              placeholder={getSymbolPlaceholder()}
              value={formData.symbol}
              onChange={(e) => handleChange('symbol', e.target.value)}
            />
            <div className="flex flex-wrap gap-2 mt-2">
              {getQuickSelections().map((symbol) => (
                <Button
                  key={symbol}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleChange('symbol', symbol)}
                >
                  {symbol}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Amount</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="Enter amount to invest"
              value={formData.amount || ''}
              onChange={(e) => handleChange('amount', parseFloat(e.target.value) || 0)}
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Invest Now</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default InvestmentModal;
