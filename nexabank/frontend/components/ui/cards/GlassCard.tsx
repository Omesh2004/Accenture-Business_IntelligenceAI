
import React from 'react';
import { cn } from '@/lib/utils';
import { useScrollAnimation } from '@/hooks/useScrollAnimation';

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  hoverEffect?: boolean;
  withBorder?: boolean;
  delay? : number;
  variant?: "default" | "light"
}

const GlassCard: React.FC<GlassCardProps> = ({ 
  children, 
  className, 
  hoverEffect = true,
  withBorder = true,
  delay = 0,
  variant = "light",
}) => {

  const { ref, isInView } = useScrollAnimation();
  const variants = {
    default:"bg-card",
    light:"bg-white"
  }


  return (
    <div 
    ref={ref}

      className={cn(
        `${variants[variant]} rounded-2xl shadow-glass transition-all duration-300 ${
          isInView
            ? "opacity-100 translate-y-0"
            : "opacity-0 translate-y-10"
        }`,
        withBorder && 'border border-white/20',
        hoverEffect && 'hover:shadow-glass-hover hover:-translate-y-1',
        className
      )
    }
     style={{ transitionDelay: `${delay}ms`}}
    >
      {children}
    </div>
  );
};

export default GlassCard;
