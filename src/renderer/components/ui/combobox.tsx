import * as React from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { ScrollArea } from './scroll-area';

export interface ComboboxOption {
  value: string;
  label: string;
  description?: string;
  /** Optional group name for grouping options (e.g., "Local Branches", "Remote Branches") */
  group?: string;
  /** Optional icon to display before the label */
  icon?: React.ReactNode;
  /** Optional badge to display after the label */
  badge?: React.ReactNode;
}

interface ComboboxProps {
  /** Currently selected value */
  value: string;
  /** Callback when value changes */
  onValueChange: (value: string) => void;
  /** Available options */
  options: ComboboxOption[];
  /** Placeholder text for the trigger button */
  placeholder?: string;
  /** Placeholder text for the search input */
  searchPlaceholder?: string;
  /** Message shown when no results match the search */
  emptyMessage?: string;
  /** Whether the combobox is disabled */
  disabled?: boolean;
  /** Additional class names for the trigger */
  className?: string;
  /** ID for the trigger element */
  id?: string;
}

const Combobox = React.forwardRef<HTMLButtonElement, ComboboxProps>(
  (
    {
      value,
      onValueChange,
      options,
      placeholder = 'Select...',
      searchPlaceholder = 'Search...',
      emptyMessage = 'No results found',
      disabled = false,
      className,
      id,
    },
    ref
  ) => {
    const [open, setOpen] = React.useState(false);
    const [search, setSearch] = React.useState('');
    const [focusedIndex, setFocusedIndex] = React.useState(-1);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const optionRefs = React.useRef<Map<number, HTMLButtonElement>>(new Map());
    const listboxId = React.useId();

    // Find the selected option's label
    const selectedOption = options.find((opt) => opt.value === value);
    const displayValue = selectedOption?.label || placeholder;

    // Filter options based on search
    const filteredOptions = React.useMemo(() => {
      if (!search.trim()) return options;
      const searchLower = search.toLowerCase();
      return options.filter(
        (opt) =>
          opt.label.toLowerCase().includes(searchLower) ||
          opt.description?.toLowerCase().includes(searchLower)
      );
    }, [options, search]);

    // Get option ID for aria-activedescendant
    const getOptionId = (index: number) => `${listboxId}-option-${index}`;

    // Get the currently focused option ID
    const activeDescendant =
      focusedIndex >= 0 && focusedIndex < filteredOptions.length
        ? getOptionId(focusedIndex)
        : undefined;

    // Focus input when popover opens, reset focused index
    React.useEffect(() => {
      if (open) {
        // Small delay to ensure the popover is rendered
        const timer = setTimeout(() => {
          inputRef.current?.focus();
        }, 0);
        // Reset focused index when opening
        setFocusedIndex(-1);
        return () => clearTimeout(timer);
      } else {
        // Clear search when closing
        setSearch('');
        setFocusedIndex(-1);
      }
    }, [open]);

    // Reset focused index when filtered options change
    React.useEffect(() => {
      setFocusedIndex(-1);
    }, []);

    // Scroll focused option into view
    React.useEffect(() => {
      if (focusedIndex >= 0) {
        const optionEl = optionRefs.current.get(focusedIndex);
        optionEl?.scrollIntoView({ block: 'nearest' });
      }
    }, [focusedIndex]);

    const handleSelect = (optionValue: string) => {
      onValueChange(optionValue);
      setOpen(false);
      setSearch('');
      setFocusedIndex(-1);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (!open) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex((prev) =>
            prev < filteredOptions.length - 1 ? prev + 1 : 0
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex((prev) =>
            prev > 0 ? prev - 1 : filteredOptions.length - 1
          );
          break;
        case 'Enter':
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < filteredOptions.length) {
            handleSelect(filteredOptions[focusedIndex].value);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setOpen(false);
          break;
        case 'Home':
          e.preventDefault();
          if (filteredOptions.length > 0) {
            setFocusedIndex(0);
          }
          break;
        case 'End':
          e.preventDefault();
          if (filteredOptions.length > 0) {
            setFocusedIndex(filteredOptions.length - 1);
          }
          break;
      }
    };

    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild disabled={disabled}>
          <button
            ref={ref}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={open ? listboxId : undefined}
            id={id}
            className={cn(
              // field-border: picks up the claude field look inside dialogs (and goes borderless in a row's control slot)
              'field-border flex h-10 w-full items-center justify-between rounded-lg',
              'border border-border bg-card px-3 py-2 text-sm',
              'text-foreground placeholder:text-muted-foreground',
              'focus:outline-none focus:ring-2 focus:ring-ring focus:border-primary',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'transition-colors duration-200',
              className
            )}
          >
            <span className={cn('flex items-center gap-2 truncate', !selectedOption && 'text-muted-foreground')}>
              {selectedOption?.icon && (
                <span className="shrink-0 text-muted-foreground">{selectedOption.icon}</span>
              )}
              <span className="truncate">{displayValue}</span>
              {selectedOption?.badge && (
                <span className="shrink-0">{selectedOption.badge}</span>
              )}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto min-w-[max(var(--radix-popover-trigger-width),13rem)] max-w-[24rem] p-0"
          align="end"
          sideOffset={4}
          onKeyDown={handleKeyDown}
        >
          {/* Search input */}
          <div className="flex items-center border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              role="searchbox"
              aria-controls={listboxId}
              aria-activedescendant={activeDescendant}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className={cn(
                'flex h-10 w-full bg-transparent py-3 px-2 text-sm',
                'placeholder:text-muted-foreground',
                'focus:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-50'
              )}
            />
          </div>

          {/* Options list */}
          <ScrollArea className="max-h-[300px] [&_[data-radix-scroll-area-viewport]>div]:!block">
            <div id={listboxId} role="listbox" aria-label={searchPlaceholder || placeholder} className="p-1">
              {filteredOptions.length === 0 ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  {emptyMessage}
                </div>
              ) : (
                filteredOptions.map((option, index) => {
                  // Check if we need to render a group header
                  const prevOption = index > 0 ? filteredOptions[index - 1] : null;
                  const showGroupHeader = option.group && option.group !== prevOption?.group;

                  return (
                    <React.Fragment key={option.value}>
                      {/* Group header */}
                      {showGroupHeader && (
                        <div
                          role="presentation"
                          className={cn(
                            'px-3 py-1.5 text-xs text-(--nav-label-color)',
                            index > 0 && '-mx-1.5 mt-1.5 border-t border-border px-4.5 pt-2.5'
                          )}
                        >
                          {option.group}
                        </div>
                      )}
                      {/* Option item */}
                      <button
                        ref={(el) => {
                          if (el) {
                            optionRefs.current.set(index, el);
                          } else {
                            optionRefs.current.delete(index);
                          }
                        }}
                        id={getOptionId(index)}
                        type="button"
                        role="option"
                        aria-selected={value === option.value}
                        onClick={() => handleSelect(option.value)}
                        onMouseEnter={() => setFocusedIndex(index)}
                        className={cn(
                          'relative flex w-full min-w-0 cursor-pointer select-none items-center',
                          'rounded-lg py-2 pl-3 pr-9 text-sm text-foreground outline-none',
                          'hover:bg-nav-hover',
                          'transition-colors duration-150',
                          focusedIndex === index && 'bg-nav-hover'
                        )}
                      >
                        {/* Selected option: blue check on the right, like claude.ai menus */}
                        <span className="absolute right-3 flex h-4 w-4 items-center justify-center">
                          {value === option.value && <Check className="h-4 w-4 text-(--menu-check)" strokeWidth={2} />}
                        </span>
                        {/* min-w-0 lets long labels shrink and end with an ellipsis */}
                        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                          {option.icon && (
                            <span className="shrink-0 text-muted-foreground">{option.icon}</span>
                          )}
                          <span className="min-w-0 truncate">{option.label}</span>
                          {option.badge && (
                            <span className="shrink-0">{option.badge}</span>
                          )}
                        </span>
                      </button>
                    </React.Fragment>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    );
  }
);

Combobox.displayName = 'Combobox';

export { Combobox };
